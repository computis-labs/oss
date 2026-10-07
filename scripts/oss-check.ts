import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { publicPackages } from "./oss-packages.ts";

const peerPackages = ["effect", "@effect/platform-node"] as const;

class OssCheckError extends Schema.TaggedError<OssCheckError>()("OssCheckError", {
  message: Schema.String,
}) {}

const StringRecord = Schema.Record(Schema.String, Schema.String);

const PublishedManifest = Schema.Struct({
  bin: Schema.optionalKey(StringRecord),
  exports: StringRecord,
  name: Schema.String,
});

const RootManifest = Schema.Struct({ devDependencies: StringRecord });

const readJson = Effect.fn("readJson")(function* readJsonProgram<
  S extends Schema.Top & { readonly DecodingServices: never },
>(schema: S, file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(file).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
    Effect.mapError(() => OssCheckError.make({ message: `${file} is not the expected JSON.` })),
  );
});

const run = Effect.fn("run")(function* runProgram(
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
  if (code !== 0) {
    return yield* OssCheckError.make({
      message: `${command} ${args.join(" ")} exited with code ${code}.\n${output}`,
    });
  }
  return output;
}, Effect.scoped);

const packTarball = Effect.fn("packTarball")(function* packTarballProgram(
  root: string,
  packs: string,
  name: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const destination = path.join(packs, name);
  yield* fs.makeDirectory(destination);
  yield* run(
    "pnpm",
    ["pack", "--pack-destination", destination],
    path.join(root, "packages", name),
  );
  const [tarball] = yield* fs.readDirectory(destination);
  if (tarball === undefined) {
    return yield* OssCheckError.make({ message: `pnpm pack wrote no tarball for ${name}.` });
  }
  return path.join(destination, tarball);
});

const exportSpecifiers = Effect.fn("exportSpecifiers")(function* exportSpecifiersProgram(
  installed: string,
  manifest: typeof PublishedManifest.Type,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const specifiers: string[] = [];
  for (const [key, target] of Object.entries(manifest.exports)) {
    if (key === "./package.json") {
      continue;
    }
    if (!key.includes("*")) {
      specifiers.push(`${manifest.name}${key.slice(1)}`);
      continue;
    }
    const [targetDir, targetExtension] = [path.dirname(target), path.extname(target)];
    const keyDir = path.dirname(key).slice(1);
    for (const entry of yield* fs.readDirectory(path.join(installed, targetDir))) {
      if (entry.endsWith(targetExtension)) {
        specifiers.push(`${manifest.name}${keyDir}/${entry.slice(0, -targetExtension.length)}`);
      }
    }
  }
  return specifiers;
});

const program = Effect.gen(function* ossCheckProgram() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dirname, "..");
  const work = yield* fs.makeTempDirectoryScoped({ prefix: "oss-check-" });
  const packs = path.join(work, "packs");
  const smoke = path.join(work, "smoke");
  yield* fs.makeDirectory(packs);
  yield* fs.makeDirectory(smoke);

  const tarballs = new Map<string, string>();
  for (const name of publicPackages) {
    tarballs.set(`@computis/${name}`, yield* packTarball(root, packs, name));
  }

  for (const tarball of tarballs.values()) {
    yield* Console.log(`Linting ${path.basename(tarball)}`);
    yield* run("pnpm", ["exec", "publint", "run", tarball, "--strict"], root);
    yield* run("pnpm", ["exec", "attw", tarball, "--profile", "esm-only"], root);
  }

  const { devDependencies } = yield* readJson(RootManifest, path.join(root, "package.json"));
  const peers = Object.fromEntries(peerPackages.map((name) => [name, devDependencies[name]]));
  const local = Object.fromEntries(
    [...tarballs].map(([name, tarball]) => [name, `file:${tarball}`]),
  );
  yield* fs.writeFileString(
    path.join(smoke, "package.json"),
    JSON.stringify({ dependencies: { ...local, ...peers }, private: true, type: "module" }),
  );
  yield* run("npm", ["install", "--no-audit", "--no-fund"], smoke);

  const imports: string[] = [];
  const bins: string[] = [];
  for (const name of publicPackages) {
    const installed = path.join(smoke, "node_modules", "@computis", name);
    const manifest = yield* readJson(PublishedManifest, path.join(installed, "package.json"));
    imports.push(...(yield* exportSpecifiers(installed, manifest)));
    bins.push(...Object.values(manifest.bin ?? {}).map((bin) => path.join(installed, bin)));
  }
  yield* fs.writeFileString(
    path.join(smoke, "smoke.mjs"),
    `for (const specifier of ${JSON.stringify(imports)}) {
  const module = await import(specifier);
  if (Object.keys(module).length === 0) throw new Error(specifier + " exports nothing");
}
`,
  );
  yield* run(process.execPath, ["smoke.mjs"], smoke);
  for (const bin of bins) {
    yield* run(process.execPath, [bin, "--help"], smoke);
  }

  yield* Console.log(
    `${tarballs.size} packages, ${imports.length} entry points and ${bins.length} CLIs load on Node ${process.version}.`,
  );
}).pipe(Effect.scoped);

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
}
