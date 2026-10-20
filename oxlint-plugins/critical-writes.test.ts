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

describe("database-policy/critical-writes", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "critical-writes-"));
    await writeFile(
      path.join(fixtureRoot, "oxlint.config.ts"),
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  overrides: [{
    files: ["apps/backend/src/**/*.ts"],
    rules: { "database-policy/critical-writes": "error" },
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
      [
        ...paths,
        "--config",
        "oxlint.config.ts",
        "--format",
        "unix",
        "--threads",
        "1",
        "--report-unused-disable-directives-severity=error",
      ],
      { cwd: fixtureRoot, encoding: "utf-8" },
    );

    return {
      output: `${result.stdout}${result.stderr}`,
      status: result.status ?? 1,
    };
  };

  it("reports a transaction on the database client, in production code and in tests", async () => {
    await writeFixture(
      "apps/backend/src/modules/folders/repository.ts",
      `export const make = Effect.gen(function* folderRepository() {
  const { db } = yield* DatabaseService;
  const rename = (id: string, name: string) =>
    db.transaction((tx) =>
      Effect.gen(function* renameTransaction() {
        yield* tx.folder.update({ data: { name }, where: { id } });
        yield* tx.file.updateMany({ data: { folderName: name }, where: { folderId: id } });
      }),
    );
  const database = yield* DatabaseService;
  const move = (id: string) => database.db.transaction(() => moveFiles(id));
  return { move, rename };
});\n`,
    );
    await writeFixture(
      "apps/backend/src/modules/folders/repository.test.ts",
      `export const program = database.db.transaction(() => Effect.fail("rollback"));\n`,
    );

    const result = runOxlint([
      "apps/backend/src/modules/folders/repository.ts",
      "apps/backend/src/modules/folders/repository.test.ts",
    ]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/database-policy\(critical-writes\)/gu)?.length,
      3,
      result.output,
    );
    assert.match(result.output, /This opens a transaction/u);
  });

  it("reports a lock option and raw serialization", async () => {
    await writeFixture(
      "apps/backend/src/modules/categories/repository.ts",
      `export const make = Effect.gen(function* categoryRepository() {
  const { db } = yield* DatabaseService;
  const findForEdit = (id: string) => db.category.findFirst({ lock: "update", where: { id } });
  const findShared = (id: string) => db.category.findMany({ "lock": { mode: "share" }, where: { id } });
  const lockCompany = Effect.fn("CategoryRepository.lockCompany")(function* lockCompanyProgram(id: string) {
    yield* db.$raw(sql\`select pg_advisory_xact_lock(hashtext(\${id}))\`);
    return yield* db.$raw(sql\`select id from category where id = \${id} for update\`);
  });
  return { findForEdit, findShared, lockCompany };
});\n`,
    );

    const result = runOxlint(["apps/backend/src/modules/categories/repository.ts"]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/database-policy\(critical-writes\)/gu)?.length,
      4,
      result.output,
    );
    assert.match(result.output, /This opens a row lock/u);
    assert.match(result.output, /This opens a lock/u);
  });

  it("allows a critical write whose line names its invariant", async () => {
    await writeFixture(
      "apps/backend/src/modules/payments/repository.ts",
      `export const make = Effect.gen(function* paymentRepository() {
  const { db } = yield* DatabaseService;
  const settle = (id: string) =>
    // oxlint-disable-next-line database-policy/critical-writes -- payments never exceed an installment under concurrent settlements
    db.transaction((tx) =>
      Effect.gen(function* settleTransaction() {
        yield* tx.installment.findMany({
          // oxlint-disable-next-line database-policy/critical-writes -- serializes concurrent settlements of one installment
          lock: "update",
          where: { id },
        });
        yield* tx.payment.create({ data: { id } });
      }),
    );
  return { settle };
});\n`,
    );

    const result = runOxlint(["apps/backend/src/modules/payments/repository.ts"]);

    assert.equal(result.status, 0, result.output);
  });

  it("allows other transaction and lock names that are not database writes", async () => {
    await writeFixture(
      "apps/backend/src/modules/audit/plugin.ts",
      `export const insertEvents = (rawDb: RawDatabase, events: readonly AuditEvent[]) =>
  rawDb.transaction((tx) => tx.insert(auditEvent).values([...events]));
export const options = { lock: true };
export const run = (mutex: Mutex) => mutex.acquire(() => ({ lock: false }));
export const label = sql\`select 'update' as kind\`;\n`,
    );

    const result = runOxlint(["apps/backend/src/modules/audit/plugin.ts"]);

    assert.equal(result.status, 0, result.output);
  });
});
