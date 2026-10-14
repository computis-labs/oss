import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(import.meta.dirname);
const oxlint = path.join(repositoryRoot, "node_modules", ".bin", "oxlint");
const plugin = fileURLToPath(new URL("require-jsonb-column-type.ts", import.meta.url));

describe("drizzle-column-policy/require-jsonb-column-type", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "require-jsonb-column-type-"));
    await writeFile(
      path.join(fixtureRoot, "oxlint.config.ts"),
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  overrides: [{
    files: ["apps/backend/src/**/*.ts"],
    rules: { "drizzle-column-policy/require-jsonb-column-type": "error" },
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

  it("reports json and jsonb columns without $type", async () => {
    await writeFixture(
      "apps/backend/src/modules/invoices/schemas/plain.ts",
      `import { json, jsonb, pgTable } from "drizzle-orm/pg-core";

export const record = pgTable("record", {
  document: jsonb("document").notNull(),
  legacy: json("legacy"),
});\n`,
    );
    await writeFixture(
      "apps/backend/src/modules/invoices/schemas/namespace.ts",
      `import * as t from "drizzle-orm/pg-core";

export const record = t.pgTable("record", {
  payload: t.jsonb("payload").notNull(),
});\n`,
    );

    const result = runOxlint([
      "apps/backend/src/modules/invoices/schemas/plain.ts",
      "apps/backend/src/modules/invoices/schemas/namespace.ts",
    ]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/drizzle-column-policy\(require-jsonb-column-type\)/gu)?.length,
      3,
      result.output,
    );
    assert.match(result.output, /Add \$type<\.\.\.>\(\) to this Drizzle json column/u);
  });

  it("allows typed columns, other builders, and unrelated json calls", async () => {
    await writeFixture(
      "apps/backend/src/modules/invoices/schemas/typed.ts",
      `import { jsonb, pgTable, text } from "drizzle-orm/pg-core";
import type { StoredDocument } from "#/modules/invoices/document-contract";

export const record = pgTable("record", {
  document: jsonb("document").$type<StoredDocument>().notNull(),
  late: jsonb("late").notNull().$type<StoredDocument>(),
  name: text("name"),
});\n`,
    );
    await writeFixture(
      "apps/backend/src/modules/invoices/parse.ts",
      `import { json } from "#/utils/json";

export const parsed = json("payload");\n`,
    );

    const result = runOxlint([
      "apps/backend/src/modules/invoices/schemas/typed.ts",
      "apps/backend/src/modules/invoices/parse.ts",
    ]);

    assert.equal(result.status, 0, result.output);
  });
});
