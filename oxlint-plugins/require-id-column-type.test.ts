import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(import.meta.dirname);
const oxlint = path.join(repositoryRoot, "node_modules", ".bin", "oxlint");
const plugin = fileURLToPath(new URL("require-id-column-type.ts", import.meta.url));

describe("drizzle-id-policy/require-id-column-type", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "require-id-column-type-"));
    await writeFile(
      path.join(fixtureRoot, "oxlint.config.ts"),
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  overrides: [{
    files: ["apps/backend/src/**/*.ts"],
    rules: { "drizzle-id-policy/require-id-column-type": "error" },
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

  it("reports uuid columns and text keys without $type", async () => {
    await writeFixture(
      "apps/backend/src/modules/invoices/schemas/plain.ts",
      `import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import { organization } from "#/modules/auth/schemas/organization";

export const record = pgTable("record", {
  companyOrganizationId: text("company_organization_id").notNull().references(() => organization.id),
  fileId: uuid("file_id"),
  id: uuid("id").defaultRandom().primaryKey(),
});

export const legacy = pgTable("legacy", {
  id: text("id").primaryKey(),
});\n`,
    );
    await writeFixture(
      "apps/backend/src/modules/invoices/schemas/namespace.ts",
      `import * as t from "drizzle-orm/pg-core";

export const record = t.pgTable("record", {
  id: t.uuid("id").defaultRandom().primaryKey(),
});\n`,
    );

    const result = runOxlint([
      "apps/backend/src/modules/invoices/schemas/plain.ts",
      "apps/backend/src/modules/invoices/schemas/namespace.ts",
    ]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/drizzle-id-policy\(require-id-column-type\)/gu)?.length,
      5,
      result.output,
    );
    assert.match(result.output, /Add \$type<\.\.\.Id>\(\) to this id column/u);
  });

  it("allows branded ids, plain text columns, and unrelated uuid calls", async () => {
    await writeFixture(
      "apps/backend/src/modules/invoices/schemas/typed.ts",
      `import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import type { InvoiceId, OrganizationId } from "@computis/shared/ids";
import { organization } from "#/modules/auth/schemas/organization";

export const record = pgTable("record", {
  companyOrganizationId: text("company_organization_id")
    .$type<OrganizationId>()
    .notNull()
    .references(() => organization.id),
  id: uuid("id").$type<InvoiceId>().defaultRandom().primaryKey(),
  late: uuid("late").defaultRandom().$type<InvoiceId>(),
  name: text("name").notNull(),
  providerRef: text("provider_ref"),
});\n`,
    );
    await writeFixture(
      "apps/backend/src/modules/invoices/ids.ts",
      `import { uuid } from "#/utils/uuid";

export const generated = uuid("seed");\n`,
    );

    const result = runOxlint([
      "apps/backend/src/modules/invoices/schemas/typed.ts",
      "apps/backend/src/modules/invoices/ids.ts",
    ]);

    assert.equal(result.status, 0, result.output);
  });
});
