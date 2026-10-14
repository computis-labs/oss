import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(import.meta.dirname);
const oxlint = path.join(repositoryRoot, "node_modules", ".bin", "oxlint");
const plugin = fileURLToPath(new URL("only-test-main-layer.ts", import.meta.url));

describe("test-layer-policy/only-test-main-layer", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "only-test-main-layer-"));
    await writeFile(
      path.join(fixtureRoot, "oxlint.config.ts"),
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  overrides: [{
    files: ["apps/backend/src/**/*.test.ts"],
    rules: { "test-layer-policy/only-test-main-layer": "error" },
  }],
};\n`,
    );
  });

  afterAll(async () => {
    await rm(fixtureRoot, { force: true, recursive: true });
  });

  const writeFixture = async (relativePath: string, source: string) => {
    const destination = path.join(fixtureRoot, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, source);
  };

  const runOxlint = (paths: readonly string[]) => {
    const result = spawnSync(
      oxlint,
      [...paths, "--config", "oxlint.config.ts", "--format", "unix", "--threads", "1"],
      { cwd: fixtureRoot, encoding: "utf-8" },
    );

    return {
      output: `${result.stdout}${result.stderr}`,
      status: result.status ?? 1,
    };
  };

  it("reports shared, wrapped, composed and hand-built suite layers", async () => {
    await writeFixture(
      "apps/backend/src/modules/shared/shared.test.ts",
      `const suiteLayer = testMainLayer({ config: { ACUBE_ENABLED: true } });

it.layer(suiteLayer)("suite", (it) => {
  it.effect("works", () => Effect.void);
});\n`,
    );
    await writeFixture(
      "apps/backend/src/modules/shared/wrapped.test.ts",
      `const suiteLayer = () => testMainLayer();

it.layer(suiteLayer())("suite", (it) => {
  it.effect("works", () => Effect.void);
});\n`,
    );
    await writeFixture(
      "apps/backend/src/modules/shared/composed.test.ts",
      `it.layer(clientLayer.pipe(Layer.provideMerge(testMainLayer())))("suite", (it) => {
  it.effect("works", () => Effect.void);
});\n`,
    );
    await writeFixture(
      "apps/backend/src/modules/shared/service-default.test.ts",
      `it.layer(InvoiceXmlService.Default)("suite", (it) => {
  it.effect("works", () => Effect.void);
});\n`,
    );

    const result = runOxlint([
      "apps/backend/src/modules/shared/shared.test.ts",
      "apps/backend/src/modules/shared/wrapped.test.ts",
      "apps/backend/src/modules/shared/composed.test.ts",
      "apps/backend/src/modules/shared/service-default.test.ts",
    ]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/test-layer-policy\(only-test-main-layer\)/gu)?.length,
      4,
      result.output,
    );
    assert.match(result.output, /must call testMainLayer\(\.\.\.\) inline/u);
  });

  it("allows inline testMainLayer calls and leaves other it methods alone", async () => {
    await writeFixture(
      "apps/backend/src/modules/inline/plain.test.ts",
      `it.layer(testMainLayer())("suite", (it) => {
  it.effect("works", () => Effect.void);
});\n`,
    );
    await writeFixture(
      "apps/backend/src/modules/inline/options.test.ts",
      `it.layer(
  testMainLayer({
    acubeSeed: { invoices: [] },
    session: { email: "someone@example.com", name: "Someone" },
  }),
)("suite", (it) => {
  it.effect("works", () => Effect.void);
});\n`,
    );
    await writeFixture(
      "apps/backend/src/modules/inline/loop.test.ts",
      `for (const appEnv of ["staging", "production"]) {
  it.layer(testMainLayer({ config: { APP_ENV: appEnv } }))(appEnv, (it) => {
    it.effect("works", () => Effect.void);
  });
}\n`,
    );
    await writeFixture(
      "apps/backend/src/modules/inline/other-methods.test.ts",
      `it.effect("works", () => Effect.void);
it("plain", () => {
  strictEqual(1, 1);
});\n`,
    );

    const result = runOxlint([
      "apps/backend/src/modules/inline/plain.test.ts",
      "apps/backend/src/modules/inline/options.test.ts",
      "apps/backend/src/modules/inline/loop.test.ts",
      "apps/backend/src/modules/inline/other-methods.test.ts",
    ]);

    assert.equal(result.status, 0, result.output);
  });
});
