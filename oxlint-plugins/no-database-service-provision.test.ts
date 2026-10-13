import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(import.meta.dirname);
const oxlint = path.join(repositoryRoot, "node_modules", ".bin", "oxlint");
const plugin = fileURLToPath(new URL("no-database-service-provision.ts", import.meta.url));

describe("database-policy/no-database-service-provision", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "database-service-provision-"));
    await writeFile(
      path.join(fixtureRoot, "oxlint.config.ts"),
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  overrides: [{
    excludeFiles: ["apps/backend/src/**/*.test.ts", "apps/backend/src/test/**/*.ts"],
    files: ["apps/backend/src/**/*.ts"],
    rules: { "database-policy/no-database-service-provision": "error" },
  }, {
    excludeFiles: ["apps/backend/src/**/*.test.ts", "apps/backend/src/test/**/*.ts", "apps/backend/src/worker/jobs/*.ts"],
    files: ["apps/backend/src/**/*.ts"],
    rules: { "database-policy/scope-at-boundary": "error" },
  }, {
    excludeFiles: ["apps/backend/src/**/*.test.ts", "apps/backend/src/test/**/*.ts", "apps/backend/src/services/database/**/*.ts"],
    files: ["apps/backend/src/**/*.ts"],
    rules: { "database-policy/db-only-in-repository": "error" },
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

  it("reports curried and direct DatabaseService provision", async () => {
    await writeFixture(
      "apps/backend/src/modules/files/curried.ts",
      `export const program = loadFile(id).pipe(
  Effect.provideService(DatabaseService, database),
);\n`,
    );
    await writeFixture(
      "apps/backend/src/modules/files/direct.ts",
      `export const program = Effect.provideService(loadFile(id), DatabaseService, database);\n`,
    );

    const result = runOxlint([
      "apps/backend/src/modules/files/curried.ts",
      "apps/backend/src/modules/files/direct.ts",
    ]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/database-policy\(no-database-service-provision\)/gu)?.length,
      2,
      result.output,
    );
    assert.match(result.output, /Do not provide DatabaseService at a call site/u);
  });

  it("rejects tenant scope provision in domain methods, including renamed imports", async () => {
    await writeFixture(
      "apps/backend/src/modules/invoices/service.ts",
      `import { OrganizationScope as Tenant } from "#/services/database/organization-scope";
export const company = Tenant.company(id)(query);
export const firm = Tenant["firm"](id)(query);
export const lookup = Tenant.companyOf(owner, idOf, missing);
`,
    );
    const result = runOxlint(["apps/backend/src/modules/invoices/service.ts"]);
    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/database-policy\(scope-at-boundary\)/gu)?.length,
      3,
      result.output,
    );
  });

  it("allows scope reads, jobs, and test boundaries", async () => {
    await writeFixture(
      "apps/backend/src/modules/invoices/read.ts",
      `export const owner = OrganizationScope.companyId;\n`,
    );
    await writeFixture(
      "apps/backend/src/worker/jobs/invoice.ts",
      `export const job = OrganizationScope.company(id)(query);\n`,
    );
    await writeFixture(
      "apps/backend/src/modules/invoices/scope.test.ts",
      `export const program = OrganizationScope.firm(id)(query);\n`,
    );
    const result = runOxlint([
      "apps/backend/src/modules/invoices/read.ts",
      "apps/backend/src/worker/jobs/invoice.ts",
      "apps/backend/src/modules/invoices/scope.test.ts",
    ]);
    assert.equal(result.status, 0, result.output);
  });

  it("allows other services, construction effects, and backend tests", async () => {
    await writeFixture(
      "apps/backend/src/modules/files/auth.ts",
      `export const program = loadFile(id).pipe(
  Effect.provideService(AuthService, auth),
);\n`,
    );
    await writeFixture(
      "apps/backend/src/modules/files/access.ts",
      `export const makeAccess = Effect.gen(function* () {
  const { db } = yield* DatabaseService;
  return (id) => query(db, id);
});\n`,
    );
    await writeFixture(
      "apps/backend/src/modules/files/service.test.ts",
      `export const layer = Effect.provideService(program, DatabaseService, database);\n`,
    );
    await writeFixture(
      "apps/backend/src/test/app.ts",
      `export const layer = program.pipe(Effect.provideService(DatabaseService, database));\n`,
    );

    const result = runOxlint([
      "apps/backend/src/modules/files/auth.ts",
      "apps/backend/src/modules/files/access.ts",
      "apps/backend/src/modules/files/service.test.ts",
      "apps/backend/src/test/app.ts",
    ]);

    assert.equal(result.status, 0, result.output);
  });

  it("reports DatabaseService in a service, a route, and a renamed import", async () => {
    await writeFixture(
      "apps/backend/src/modules/drive/service.ts",
      `import { DatabaseService } from "#/services/database/port";
export const make = Effect.gen(function* makeProgram() {
  const { db } = yield* DatabaseService;
  return db.transaction(() => rename(id));
});\n`,
    );
    await writeFixture(
      "apps/backend/src/routes/drive/folders/get.ts",
      `import { DatabaseService as Database } from "#/services/database/port";\nexport const handler = Database;\n`,
    );
    const result = runOxlint([
      "apps/backend/src/modules/drive/service.ts",
      "apps/backend/src/routes/drive/folders/get.ts",
    ]);
    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/database-policy\(db-only-in-repository\)/gu)?.length,
      2,
      result.output,
    );
    assert.match(result.output, /Only a repository\.ts or <name>-repository\.ts file/u);
  });

  it("allows DatabaseService in repositories, the database service, and tests", async () => {
    const source = `import { DatabaseService } from "#/services/database/port";\nexport const service = DatabaseService;\n`;
    await writeFixture("apps/backend/src/modules/drive/repository.ts", source);
    await writeFixture("apps/backend/src/modules/invoice-payments/ledger-repository.ts", source);
    await writeFixture("apps/backend/src/services/database/live.ts", source);
    await writeFixture("apps/backend/src/modules/drive/service.test.ts", source);
    await writeFixture("apps/backend/src/test/database.ts", source);
    const result = runOxlint([
      "apps/backend/src/modules/drive/repository.ts",
      "apps/backend/src/modules/invoice-payments/ledger-repository.ts",
      "apps/backend/src/services/database/live.ts",
      "apps/backend/src/modules/drive/service.test.ts",
      "apps/backend/src/test/database.ts",
    ]);
    assert.equal(result.status, 0, result.output);
  });
});
