import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Console, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { publicPackages, publicRepository } from "./oss-packages.ts";

const unreleasedVersion = "0.0.0";

class OssReleaseError extends Schema.TaggedError<OssReleaseError>()("OssReleaseError", {
  message: Schema.String,
}) {}

const PackageManifest = Schema.Struct({ name: Schema.String, version: Schema.String });

const dryRun = process.argv.includes("--dry-run");

export const releaseNotes = (changelog: string, version: string) => {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start === -1) {
    return Option.none<string>();
  }
  const next = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return Option.some(
    lines
      .slice(start + 1, next === -1 ? undefined : next)
      .join("\n")
      .trim(),
  ).pipe(Option.filter((notes) => notes !== ""));
};

export const isPrerelease = (version: string) => version.includes("-");

const exec = Effect.fn("exec")(function* execProgram(
  command: string,
  args: readonly string[],
  cwd: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner.spawn(
    ChildProcess.make(command, args, { cwd, stderr: "inherit", stdin: "ignore" }),
  );
  const [output, code] = yield* Effect.all(
    [handle.stdout.pipe(Stream.decodeText, Stream.mkString), handle.exitCode],
    { concurrency: 2 },
  );
  return { code, output };
}, Effect.scoped);

const run = Effect.fn("run")(function* runProgram(
  command: string,
  args: readonly string[],
  cwd: string,
) {
  const { code, output } = yield* exec(command, args, cwd);
  if (code !== 0) {
    return yield* OssReleaseError.make({
      message: `${command} ${args.join(" ")} exited with code ${code}.\n${output}`,
    });
  }
  return output;
});

const isPublished = Effect.fn("isPublished")(function* isPublishedProgram(
  manifest: typeof PackageManifest.Type,
) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(
    HttpClientRequest.get(
      `https://registry.npmjs.org/${manifest.name.replace("/", "%2f")}/${manifest.version}`,
    ),
  );
  if (response.status === 200) {
    return true;
  }
  if (response.status === 404) {
    return false;
  }
  return yield* OssReleaseError.make({
    message: `The npm registry answered ${response.status} for ${manifest.name}@${manifest.version}.`,
  });
});

const publish = Effect.fn("publish")(function* publishProgram(
  directory: string,
  manifest: typeof PackageManifest.Type,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const destination = yield* fs.makeTempDirectoryScoped({ prefix: "oss-release-" });
  yield* run("pnpm", ["pack", "--pack-destination", destination], directory);
  const [packed] = yield* fs.readDirectory(destination);
  const tarball = yield* Option.match(Option.fromNullishOr(packed), {
    onNone: () =>
      OssReleaseError.make({ message: `pnpm pack wrote no tarball for ${manifest.name}.` }),
    onSome: Effect.succeed,
  });
  const tag = isPrerelease(manifest.version) ? ["--tag", "next"] : [];
  yield* run(
    "npm",
    [
      "publish",
      path.join(destination, tarball),
      "--access",
      "public",
      ...tag,
      ...(dryRun ? ["--dry-run"] : []),
    ],
    directory,
  );
  yield* Console.log(`Published ${manifest.name}@${manifest.version}.`);
}, Effect.scoped);

const ensureGitHubRelease = Effect.fn("ensureGitHubRelease")(function* ensureGitHubReleaseProgram(
  directory: string,
  manifest: typeof PackageManifest.Type,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repository = yield* Config.NonEmptyString("GITHUB_REPOSITORY").pipe(
    Config.withDefault(publicRepository),
  );
  const tag = `${manifest.name}@${manifest.version}`;
  const existing = yield* exec("gh", ["release", "view", tag, "--repo", repository], directory);
  if (existing.code === 0) {
    return;
  }
  const target = yield* Config.NonEmptyString("GITHUB_SHA");
  const changelog = path.join(directory, "CHANGELOG.md");
  const notes = (yield* fs.exists(changelog))
    ? releaseNotes(yield* fs.readFileString(changelog), manifest.version)
    : Option.none<string>();
  const args = [
    "release",
    "create",
    tag,
    "--repo",
    repository,
    "--target",
    target,
    "--title",
    tag,
    "--notes",
    Option.getOrElse(notes, () => `Release ${tag}.`),
    ...(isPrerelease(manifest.version) ? ["--prerelease"] : []),
  ];
  if (dryRun) {
    yield* Console.log(`Would run: gh ${args.slice(0, 9).join(" ")}`);
    return;
  }
  yield* run("gh", args, directory);
  yield* Console.log(`Created the GitHub release ${tag}.`);
});

const program = Effect.gen(function* ossReleaseProgram() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dirname, "..");
  for (const name of publicPackages) {
    const directory = path.join(root, "packages", name);
    const manifest = yield* fs.readFileString(path.join(directory, "package.json")).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(PackageManifest))),
      Effect.mapError(() =>
        OssReleaseError.make({
          message: `packages/${name}/package.json is not a package manifest.`,
        }),
      ),
    );
    if (manifest.version === unreleasedVersion) {
      yield* Console.log(`${manifest.name} has no release yet.`);
      continue;
    }
    yield* (yield* isPublished(manifest))
      ? Console.log(`${manifest.name}@${manifest.version} is already on npm.`)
      : publish(directory, manifest);
    yield* ensureGitHubRelease(directory, manifest);
  }
});

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  NodeRuntime.runMain(
    program.pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici))),
  );
}
