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

describe("layout-policy/no-route-guards", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "no-route-guards-"));
    await writeFile(
      path.join(fixtureRoot, "oxlint.config.ts"),
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  overrides: [{
    files: ["apps/backend/src/routes/**/{index,get,post,put,patch,delete}.ts"],
    rules: { "layout-policy/no-route-guards": "error" },
  }],
};
`,
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

  it("reports a require* guard yielded as an identifier in a route handler", async () => {
    await writeFixture(
      "apps/backend/src/routes/dev/seed/index.ts",
      `export const handler = function* seedTestDataHandler(requireSeedEnvironment: unknown, seed: unknown) {
  yield* requireSeedEnvironment;
  return yield* seed;
};\n`,
    );

    const result = runOxlint(["apps/backend/src/routes/dev/seed/index.ts"]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/layout-policy\(no-route-guards\)/gu)?.length,
      1,
      result.output,
    );
    assert.match(result.output, /Run the check in the route group's middleware/u);
  });

  it("reports a require* guard called directly or on a service in a method handler", async () => {
    await writeFixture(
      "apps/backend/src/routes/company-modules/module/put.ts",
      `declare const requireCompanyModules: (id: string) => Iterable<unknown>;
declare const firms: { requireFirmAdmin: (id: string) => Iterable<unknown> };

export const updateCompanyModule = function* updateCompanyModuleProgram(id: string) {
  yield* requireCompanyModules(id);
  yield* firms.requireFirmAdmin(id);
};\n`,
    );

    const result = runOxlint(["apps/backend/src/routes/company-modules/module/put.ts"]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/layout-policy\(no-route-guards\)/gu)?.length,
      2,
      result.output,
    );
  });

  it("allows other yields in a route handler, and guards outside route handlers", async () => {
    await writeFixture(
      "apps/backend/src/routes/company-modules/disable-check/get.ts",
      `declare const requirements: Iterable<unknown>;
declare const required: { permission: Iterable<unknown> };
declare const loadModule: (id: string) => Iterable<unknown>;

export const disableCheck = function* disableCheckProgram(id: string) {
  yield* requirements;
  yield* required.permission;
  return yield* loadModule(id);
};\n`,
    );
    await writeFixture(
      "apps/backend/src/routes/company-modules/disable-check/get.test.ts",
      `declare const requireCompanyModules: Iterable<unknown>;

export const scenario = function* scenarioProgram() {
  yield* requireCompanyModules;
};\n`,
    );
    await writeFixture(
      "apps/backend/src/http/middleware/firm-admin-live.ts",
      `declare const requireFirmAdmin: (id: string) => Iterable<unknown>;

export const firmAdminAuthorization = function* firmAdminAuthorizationProgram(id: string) {
  yield* requireFirmAdmin(id);
};\n`,
    );

    const result = runOxlint([
      "apps/backend/src/routes/company-modules/disable-check/get.ts",
      "apps/backend/src/routes/company-modules/disable-check/get.test.ts",
      "apps/backend/src/http/middleware/firm-admin-live.ts",
    ]);

    assert.equal(result.status, 0, result.output);
  });
});
