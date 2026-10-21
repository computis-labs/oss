import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema, pipe } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const OPTIONAL_PEERS = [
  "@effect/vitest",
  "@resvg/resvg-js",
  "simple-ascii-chart",
  "terminal-image",
  "vega",
  "vega-lite",
  "vitest",
];

const PEER_ENTRYPOINTS = new Set(["./chart-unicode", "./chart-vega", "./vitest"]);

const IMPORT_SPECIFIER = /(?:from|import)\s*\(?\s*"(?<specifier>[^"]+)"/gu;

const denyingHook = `const denied = new Set(${JSON.stringify(OPTIONAL_PEERS)});
export async function resolve(specifier, context, next) {
  if (denied.has(specifier)) {
    throw new Error("optional peer: " + specifier);
  }
  return next(specifier, context);
}
`;

const ManifestSchema = Schema.Struct({
  exports: Schema.Record(Schema.String, Schema.String),
});

const packageFolder = Effect.gen(function* () {
  const paths = yield* Path.Path;
  return paths.resolve(import.meta.dirname, "..");
});

const sourcesOf = (folder: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const names = yield* fs.readDirectory(folder, { recursive: true });
    return names.filter((name) => name.endsWith(".ts")).map((name) => paths.join(folder, name));
  });

const importsWithPeersDenied = (files: readonly string[]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const folder = yield* fs.makeTempDirectoryScoped();
    const hook = paths.join(folder, "deny-optional-peers.mjs");
    yield* fs.writeFileString(hook, denyingHook);
    const hookUrl = yield* paths.toFileUrl(hook);
    const urls = yield* pipe(
      files,
      Effect.forEach((file) => paths.toFileUrl(file).pipe(Effect.map((url) => url.href))),
    );
    const script = `import { register } from "node:module";
register(${JSON.stringify(hookUrl.href)});
const refused = [];
for (const url of ${JSON.stringify(urls)}) {
  try { await import(url); } catch (error) { refused.push([url, String(error.message).split("\\n")[0]]); }
}
process.stdout.write(JSON.stringify(refused));
`;
    const output = yield* spawner.string(
      ChildProcess.make("node", ["--no-warnings", "--input-type=module", "-e", script], {
        extendEnv: true,
      }),
    );
    return yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Array(Schema.Tuple([Schema.String, Schema.String]))),
    )(output);
  }).pipe(Effect.scoped);

describe("the published package", () => {
  it.effect(
    "loads every core entrypoint without the optional peers",
    () =>
      Effect.gen(function* () {
        const folder = yield* packageFolder;
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ManifestSchema))(
          yield* fs.readFileString(paths.join(folder, "package.json")),
        );
        const core = Object.entries(manifest.exports)
          .filter(([entry, file]) => !PEER_ENTRYPOINTS.has(entry) && file.endsWith(".ts"))
          .filter(([, file]) => !file.includes("*"))
          .map(([, file]) => paths.join(folder, file));
        const errors = yield* sourcesOf(paths.join(folder, "src/errors"));

        expect(yield* importsWithPeersDenied([...core, ...errors])).toEqual([]);
      }).pipe(Effect.provide(NodeServices.layer)),
    60_000,
  );

  it.effect(
    "refuses an optional peer to the guard, so the check above can fail",
    () =>
      Effect.gen(function* () {
        const folder = yield* packageFolder;
        const paths = yield* Path.Path;

        const refused = yield* importsWithPeersDenied([paths.join(folder, "src/chart-unicode.ts")]);

        expect(refused.map(([, message]) => message)).toEqual([
          "optional peer: simple-ascii-chart",
        ]);
      }).pipe(Effect.provide(NodeServices.layer)),
    60_000,
  );

  it.effect("imports nothing from node: or @computis/ in its sources", () =>
    Effect.gen(function* () {
      const folder = yield* packageFolder;
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const files = yield* sourcesOf(paths.join(folder, "src"));
      const forbidden = yield* pipe(
        files,
        Effect.forEach((file) =>
          fs.readFileString(file).pipe(
            Effect.map((text) =>
              [...text.matchAll(IMPORT_SPECIFIER)]
                .map((match) => match.groups?.["specifier"] ?? "")
                .filter(
                  (specifier) =>
                    specifier.startsWith("node:") || specifier.startsWith("@computis/"),
                )
                .map((specifier) => `${paths.relative(folder, file)}: ${specifier}`),
            ),
          ),
        ),
      );

      expect(files.length).toBeGreaterThan(0);
      expect(forbidden.flat()).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
