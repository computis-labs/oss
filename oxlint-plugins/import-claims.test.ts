import assert from "node:assert/strict";
import { NodeServices } from "@effect/platform-node";
import { layer } from "@effect/vitest";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const oxlint = new URL("../node_modules/.bin/oxlint", import.meta.url).pathname;
const plugin = new URL("no-single-use-helpers.ts", import.meta.url).pathname;

const lintFixtures = Effect.fn("lintFixtures")(function* lintFixtures(
  fixtures: Readonly<Record<string, string>>,
  paths: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "import-claims-" });

  yield* fs.writeFileString(
    path.join(root, "oxlint.config.ts"),
    `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  rules: { "helper-policy/no-single-use-helpers": "error" },
};
`,
  );
  yield* Effect.forEach(Object.entries(fixtures), ([relativePath, source]) =>
    Effect.andThen(
      fs.makeDirectory(path.dirname(path.join(root, relativePath)), { recursive: true }),
      fs.writeFileString(path.join(root, relativePath), source),
    ),
  );

  const handle = yield* spawner.spawn(
    ChildProcess.make(
      oxlint,
      [...paths, "--config", "oxlint.config.ts", "--format", "unix", "--threads", "1"],
      { cwd: root },
    ),
  );
  const [stdout, stderr, status] = yield* Effect.all(
    [
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)),
      handle.exitCode,
    ],
    { concurrency: "unbounded" },
  );

  return { output: `${stdout}${stderr}`, status };
}, Effect.scoped);

layer(NodeServices.layer)("helper-policy/no-single-use-helpers import claims", (it) => {
  it.effect("allows a type that another file reaches through a type-only namespace import", () =>
    Effect.gen(function* () {
      const result = yield* lintFixtures(
        {
          "apps/backend/src/modules/type-namespace/journal.ts": `import type * as Ledger from "./ledger.ts";

export const opening: Ledger.LedgerSide = "debit";\n`,
          "apps/backend/src/modules/type-namespace/ledger.ts": `export type LedgerSide = "debit" | "credit";

export const flip = (side: LedgerSide) => (side === "debit" ? "credit" : "debit");\n`,
        },
        [
          "apps/backend/src/modules/type-namespace/ledger.ts",
          "apps/backend/src/modules/type-namespace/journal.ts",
        ],
      );

      assert.equal(result.status, 0, result.output);
    }),
  );

  it.effect("reports a public package type that only a private app imports", () =>
    Effect.gen(function* () {
      const result = yield* lintFixtures(
        {
          "apps/web/src/claims/opening.ts": `import type { PrivatelyClaimedSide } from "@computis/effect-md/claims/side";

export const opening: PrivatelyClaimedSide = "debit";\n`,
          "packages/effect-md/src/claims/side.ts": `export type PrivatelyClaimedSide = "debit" | "credit";

export const flipSide = (side: PrivatelyClaimedSide) => (side === "debit" ? "credit" : "debit");\n`,
        },
        ["packages/effect-md/src/claims/side.ts"],
      );

      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /Type alias 'PrivatelyClaimedSide' is only used once/u);
    }),
  );

  it.effect("allows a public package type that another public package imports", () =>
    Effect.gen(function* () {
      const result = yield* lintFixtures(
        {
          "packages/effect-md/src/claims/entry.ts": `export type PubliclyClaimedEntry = "debit" | "credit";

export const flipEntry = (entry: PubliclyClaimedEntry) => (entry === "debit" ? "credit" : "debit");\n`,
          "packages/effect-xml/src/claims/opening.ts": `import type { PubliclyClaimedEntry } from "@computis/effect-md/claims/entry";

export const opening: PubliclyClaimedEntry = "debit";\n`,
        },
        ["packages/effect-md/src/claims/entry.ts"],
      );

      assert.equal(result.status, 0, result.output);
    }),
  );
});
