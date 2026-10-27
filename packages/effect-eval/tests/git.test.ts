import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer, Option, PlatformError } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Git from "../src/git.ts";

describe("Git.Git", () => {
  it.effect("knows nothing about the repository by default", () =>
    Effect.gen(function* () {
      const git = yield* Git.Git;

      expect(yield* git.current).toEqual(Git.unknownInfo);
    }),
  );
});

describe("Git.layerStatic", () => {
  it.effect("reports the info it was given", () =>
    Effect.gen(function* () {
      const git = yield* Git.Git;

      expect(yield* git.current).toEqual({
        branch: Option.some("main"),
        dirty: false,
        sha: Option.some("abc1234"),
      });
    }).pipe(
      Effect.provide(
        Git.layerStatic({ branch: Option.some("main"), dirty: false, sha: Option.some("abc1234") }),
      ),
    ),
  );
});

const fromEnvironment = (env: Record<string, string>, layer = Git.layerProcess) =>
  Layer.merge(
    layer.pipe(Layer.provide(NodeServices.layer)),
    ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
  );

const runIn = (directory: string, args: readonly string[]) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    return yield* spawner.string(
      ChildProcess.make("git", args, {
        cwd: directory,
        env: {
          GIT_AUTHOR_EMAIL: "eval@example.com",
          GIT_AUTHOR_NAME: "eval",
          GIT_COMMITTER_EMAIL: "eval@example.com",
          GIT_COMMITTER_NAME: "eval",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
        extendEnv: true,
      }),
    );
  });

const repository = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped();
  yield* runIn(directory, ["init", "--initial-branch", "eval/known"]);
  yield* fs.writeFileString(`${directory}/case.json`, "{}");
  yield* runIn(directory, ["add", "case.json"]);
  yield* runIn(directory, ["commit", "--message", "known commit"]);
  const sha = yield* runIn(directory, ["rev-parse", "HEAD"]);

  return { directory, sha: sha.trim() };
});

const noGit = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() =>
    Effect.fail(
      PlatformError.systemError({
        _tag: "NotFound",
        description: "spawn git ENOENT",
        method: "spawn",
        module: "ChildProcess",
      }),
    ),
  ),
);

describe("Git.layerProcess", () => {
  it.effect("prefers the sha and branch GitHub Actions sets", () =>
    Effect.gen(function* () {
      const git = yield* Git.Git;
      const info = yield* git.current;

      expect([info.sha, info.branch]).toEqual([
        Option.some("deadbeef"),
        Option.some("release/1.2"),
      ]);
    }).pipe(
      Effect.provide(fromEnvironment({ GITHUB_REF_NAME: "release/1.2", GITHUB_SHA: "deadbeef" })),
    ),
  );

  it.effect("asks git for the sha, branch and state of the working copy", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { directory, sha } = yield* repository;

      const read = Effect.service(Git.Git).pipe(
        Effect.flatMap((git) => git.current),
        Effect.provide(fromEnvironment({}, Git.layerProcessAt(directory))),
      );

      const clean = yield* read;
      yield* fs.writeFileString(`${directory}/case.json`, '{"changed":true}');
      const dirty = yield* read;

      expect(sha).toMatch(/^[0-9a-f]{40}$/u);
      expect(clean).toEqual({
        branch: Option.some("eval/known"),
        dirty: false,
        sha: Option.some(sha),
      });
      expect(dirty.dirty).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("knows nothing when git cannot run", () =>
    Effect.gen(function* () {
      const git = yield* Git.Git;

      expect(yield* git.current).toEqual(Git.unknownInfo);
    }).pipe(
      Effect.provide(
        Layer.merge(
          Git.layerProcess.pipe(Layer.provide(noGit)),
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
        ),
      ),
    ),
  );
});
