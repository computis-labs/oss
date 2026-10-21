import { Config, Context, Effect, Layer, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { GitInfo } from "./events.ts";

export const unknownInfo: GitInfo = {
  branch: Option.none(),
  dirty: false,
  sha: Option.none(),
};

export const Git = Context.Reference<{ readonly current: Effect.Effect<GitInfo> }>(
  "effect-eval/Git",
  { defaultValue: () => ({ current: Effect.succeed(unknownInfo) }) },
);

export const layerStatic = (info: GitInfo) => Layer.succeed(Git, { current: Effect.succeed(info) });

const fromEnvironment = (name: string) =>
  Config.option(Config.String(name)).pipe(Effect.orElseSucceed(() => Option.none<string>()));

const processLayer = (cwd: Option.Option<string>) =>
  Layer.effect(
    Git,
    Effect.gen(function* makeGit() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const git = (args: readonly string[]) =>
        Effect.scoped(
          Effect.gen(function* runGit() {
            const handle = yield* spawner.spawn(
              ChildProcess.make("git", args, {
                ...Option.match(cwd, {
                  onNone: () => ({}),
                  onSome: (directory) => ({ cwd: directory }),
                }),
                stderr: "ignore",
                stdin: "ignore",
              }),
            );
            const [output, code] = yield* Effect.all(
              [handle.stdout.pipe(Stream.decodeText, Stream.mkString), handle.exitCode],
              { concurrency: 2 },
            );
            return code === 0 ? Option.some(output.trim()) : Option.none<string>();
          }),
        ).pipe(Effect.orElseSucceed(() => Option.none<string>()));
      return {
        current: Effect.gen(function* currentGit() {
          const sha = yield* fromEnvironment("GITHUB_SHA");
          const branch = yield* fromEnvironment("GITHUB_REF_NAME");
          const status = yield* git(["status", "--porcelain"]);
          return {
            branch: Option.isSome(branch)
              ? branch
              : yield* git(["rev-parse", "--abbrev-ref", "HEAD"]),
            dirty: Option.exists(status, (text) => text.length > 0),
            sha: Option.isSome(sha) ? sha : yield* git(["rev-parse", "HEAD"]),
          };
        }),
      };
    }),
  );

export const layerProcess = processLayer(Option.none());

export const layerProcessAt = (directory: string) => processLayer(Option.some(directory));
