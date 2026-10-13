import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(import.meta.dirname);
const oxlint = path.join(repositoryRoot, "node_modules", ".bin", "oxlint");
const plugin = fileURLToPath(new URL("no-hardcoded-enum-values.ts", import.meta.url));

const STATUS_MODULE = `export const invoiceStatuses = {
  delivered: "delivered",
  draft: "draft",
  failed: "failed",
  sending: "sending",
  waiting: "waiting",
} as const;

export const invoiceStatusCodes = [
  invoiceStatuses.draft,
  invoiceStatuses.sending,
  invoiceStatuses.waiting,
  invoiceStatuses.delivered,
  invoiceStatuses.failed,
] as const;

export type InvoiceStatusCode = (typeof invoiceStatusCodes)[number];

export const DocumentTypes = {
  TD01: { code: "TD01", label: "Fattura" },
  TD04: { code: "TD04", label: "Nota di credito" },
} as const;

export type DocumentTypeCode = keyof typeof DocumentTypes;

export const rates = {
  "0": "0",
  "22": "22",
} as const;

export type Rate = (typeof rates)[keyof typeof rates];
`;

const SCHEMA_MODULE = `import { pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { invoiceStatuses } from "#/shared/status";

export const invoiceStatus = pgEnum("invoice_status", [
  invoiceStatuses.draft,
  invoiceStatuses.sending,
  invoiceStatuses.waiting,
  invoiceStatuses.delivered,
  invoiceStatuses.failed,
]);

export const invoiceRecord = pgTable("invoice", {
  id: uuid("id").primaryKey(),
  number: text("number"),
  status: invoiceStatus("status").notNull(),
});
`;

const countReports = (output: string) =>
  output.match(/enum-value-policy\(no-hardcoded-enum-values\)/gu)?.length ?? 0;

describe("enum-value-policy/no-hardcoded-enum-values", () => {
  let fixtureRoot = "";

  const writeFixture = async (relativePath: string, source: string) => {
    const destination = path.join(fixtureRoot, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, source);
  };

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "no-hardcoded-enum-values-"));
    await writeFile(
      path.join(fixtureRoot, "oxlint.config.ts"),
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  overrides: [{
    files: ["src/**/*.ts"],
    rules: { "enum-value-policy/no-hardcoded-enum-values": "error" },
  }],
};\n`,
    );
    await writeFile(
      path.join(fixtureRoot, "package.json"),
      `${JSON.stringify({ imports: { "#/*": { source: "./src/*.ts" } }, name: "fixture", type: "module" }, null, 2)}\n`,
    );
    await writeFixture("src/shared/status.ts", STATUS_MODULE);
    await writeFixture("src/db/schema.ts", SCHEMA_MODULE);
  });

  afterAll(async () => {
    await rm(fixtureRoot, { force: true, recursive: true });
  });

  const runOxlint = (paths: readonly string[], extra: readonly string[] = []) => {
    const result = spawnSync(
      oxlint,
      [...paths, "--config", "oxlint.config.ts", "--format", "unix", "--threads", "1", ...extra],
      { cwd: fixtureRoot, encoding: "utf-8" },
    );

    return {
      output: `${result.stdout}${result.stderr}`,
      status: result.status ?? 1,
    };
  };

  it("reports literals written to enum-backed drizzle columns", async () => {
    await writeFixture(
      "src/modules/writes.ts",
      `import { eq, inArray } from "drizzle-orm";
import { invoiceRecord } from "#/db/schema";

export const write = (db: any) => {
  db.insert(invoiceRecord).values({ id: "1", number: "7", status: "draft" });
  db.update(invoiceRecord).set({ status: "waiting" }).where(eq(invoiceRecord.status, "sending"));
  db.select().from(invoiceRecord).where(inArray(invoiceRecord.status, ["draft", "failed"]));
};\n`,
    );

    const result = runOxlint(["src/modules/writes.ts"]);

    assert.equal(result.status, 1);
    assert.equal(countReports(result.output), 5, result.output);
    assert.match(result.output, /Import invoiceStatuses and use invoiceStatuses\.draft/u);
    // `number` is a plain text column, so its literal stays untouched.
    assert.doesNotMatch(result.output, /"7"/u);
  });

  it("reports literals in positions annotated with an enum-backed type", async () => {
    await writeFixture(
      "src/modules/annotations.ts",
      `import type { DocumentTypeCode, InvoiceStatusCode, Rate } from "#/shared/status";

interface Draft {
  readonly rate: Rate;
  readonly status: InvoiceStatusCode;
}

export const transition = (status: InvoiceStatusCode, kind: DocumentTypeCode = "TD01") =>
  \`\${status}:\${kind}\`;

export const current: InvoiceStatusCode = "sending";

export const draft: Draft = { rate: "22", status: "failed" };

export const many: readonly InvoiceStatusCode[] = ["draft", "waiting"];

export const pick = (): InvoiceStatusCode => "delivered";

export const call = () => transition("waiting");\n`,
    );

    const result = runOxlint(["src/modules/annotations.ts"]);

    assert.equal(result.status, 1);
    assert.equal(countReports(result.output), 8, result.output);
    // Nested `{ code }` tables report the full accessor path.
    assert.match(result.output, /use DocumentTypes\.TD01\.code/u);
    // Non-identifier keys fall back to bracket access.
    assert.match(result.output, /use rates\["22"\]/u);
  });

  it("allows constants, unrelated literals, and untyped positions", async () => {
    await writeFixture(
      "src/modules/clean.ts",
      `import { eq } from "drizzle-orm";
import { invoiceRecord } from "#/db/schema";
import { invoiceStatuses } from "#/shared/status";

import type { InvoiceStatusCode } from "#/shared/status";

export const current: InvoiceStatusCode = invoiceStatuses.sending;

export const label: string = "waiting";

export const loose = { status: "waiting" };

export const write = (db: any) => {
  db.update(invoiceRecord)
    .set({ number: "waiting", status: invoiceStatuses.waiting })
    .where(eq(invoiceRecord.number, "draft"));
};\n`,
    );

    const result = runOxlint(["src/modules/clean.ts"]);

    assert.equal(result.status, 0, result.output);
  });

  it("fixes literals when the owning constant is already in scope", async () => {
    await writeFixture(
      "src/modules/fixable.ts",
      `import { invoiceStatuses } from "#/shared/status";

import type { InvoiceStatusCode } from "#/shared/status";

export const current: InvoiceStatusCode = "waiting";

export const other = invoiceStatuses.draft;\n`,
    );

    const result = runOxlint(["src/modules/fixable.ts"], ["--fix"]);

    assert.equal(result.status, 0, result.output);
    const fixed = await readFile(path.join(fixtureRoot, "src/modules/fixable.ts"), "utf-8");
    assert.match(fixed, /export const current: InvoiceStatusCode = invoiceStatuses\.waiting;/u);
  });

  it("does not fix when the owning constant is not imported", async () => {
    await writeFixture(
      "src/modules/unfixable.ts",
      `import type { InvoiceStatusCode } from "#/shared/status";

export const current: InvoiceStatusCode = "waiting";\n`,
    );

    const result = runOxlint(["src/modules/unfixable.ts"], ["--fix"]);

    assert.equal(result.status, 1, result.output);
    const untouched = await readFile(path.join(fixtureRoot, "src/modules/unfixable.ts"), "utf-8");
    assert.match(untouched, /[=] "waiting";/u);
  });
});
