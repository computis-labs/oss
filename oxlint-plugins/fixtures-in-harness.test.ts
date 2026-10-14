import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(import.meta.dirname);
const oxlint = path.join(repositoryRoot, "node_modules", ".bin", "oxlint");
const plugin = fileURLToPath(new URL("fixtures-in-harness.ts", import.meta.url));

describe("test-fixture-policy/fixtures-in-harness", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "fixtures-in-harness-"));
    await writeFile(
      path.join(fixtureRoot, "oxlint.config.ts"),
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  overrides: [{
    files: ["apps/backend/src/**/*.fixtures.ts", "apps/backend/src/**/test-harness.ts", "apps/backend/src/test/fixtures/**/*.ts"],
    rules: { "test-fixture-policy/fixtures-in-harness": "error" },
  }],
};\n`,
    );
  });

  afterAll(async () => {
    await rm(fixtureRoot, { force: true, recursive: true });
  });

  const writeFixture = async (relativePath: string) => {
    const destination = path.join(fixtureRoot, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, "export const seedThing = () => 1;\n");
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

  it("reports fixture files that sit next to the suites", async () => {
    await writeFixture("apps/backend/src/routes/drive/drive.fixtures.ts");
    await writeFixture("apps/backend/src/worker/jobs/test-harness.ts");

    const result = runOxlint([
      "apps/backend/src/routes/drive/drive.fixtures.ts",
      "apps/backend/src/worker/jobs/test-harness.ts",
    ]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/test-fixture-policy\(fixtures-in-harness\)/gu)?.length,
      2,
      result.output,
    );
    assert.match(result.output, /apps\/backend\/src\/test\/fixtures\/<domain>\.ts/u);
  });

  it("allows fixture files in the harness", async () => {
    await writeFixture("apps/backend/src/test/fixtures/drive.ts");

    const result = runOxlint(["apps/backend/src/test/fixtures/drive.ts"]);

    assert.equal(result.status, 0, result.output);
  });
});
