import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(import.meta.dirname);
const oxlint = path.join(repositoryRoot, "node_modules", ".bin", "oxlint");
const plugin = fileURLToPath(new URL("module-tests.ts", import.meta.url));

describe("layout-policy/module-tests", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "module-tests-"));
    await writeFile(
      path.join(fixtureRoot, "oxlint.config.ts"),
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  overrides: [{
    files: [
      "apps/backend/src/modules/**/{service,repository,*-service,*-repository}.ts",
      "apps/backend/src/http/middleware/*-live.ts",
    ],
    rules: { "layout-policy/module-tests": "error" },
  }],
};
`,
    );
  });

  afterAll(async () => {
    await rm(fixtureRoot, { force: true, recursive: true });
  });

  const writeFixture = async (relativePath: string, source = "export const value = 1;\n") => {
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

  it("reports a service, a repository, and a middleware without a sibling test", async () => {
    await writeFixture("apps/backend/src/modules/drive/service.ts");
    await writeFixture("apps/backend/src/modules/invoice-payments/ledger-repository.ts");
    await writeFixture("apps/backend/src/http/middleware/firm-admin-live.ts");

    const result = runOxlint([
      "apps/backend/src/modules/drive/service.ts",
      "apps/backend/src/modules/invoice-payments/ledger-repository.ts",
      "apps/backend/src/http/middleware/firm-admin-live.ts",
    ]);

    assert.equal(result.status, 1);
    assert.equal(result.output.match(/layout-policy\(module-tests\)/gu)?.length, 3, result.output);
    assert.match(result.output, /Write ledger-repository\.test\.ts next to it/u);
  });

  it("allows files with a sibling test, and files outside the scope", async () => {
    await writeFixture("apps/backend/src/modules/categories/repository.ts");
    await writeFixture("apps/backend/src/modules/categories/repository.test.ts");
    await writeFixture("apps/backend/src/modules/categories/presets.ts");
    await writeFixture("apps/backend/src/http/middleware/firm-admin.ts");

    const result = runOxlint([
      "apps/backend/src/modules/categories/repository.ts",
      "apps/backend/src/modules/categories/presets.ts",
      "apps/backend/src/http/middleware/firm-admin.ts",
    ]);

    assert.equal(result.status, 0, result.output);
  });
});
