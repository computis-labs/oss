import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(import.meta.dirname);
const oxlint = path.join(repositoryRoot, "node_modules", ".bin", "oxlint");
const plugin = fileURLToPath(new URL("require-tagged-error-code.ts", import.meta.url));

describe("error-code-policy/require-tagged-error-code", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "require-tagged-error-code-"));
    await writeFile(
      path.join(fixtureRoot, "oxlint.config.ts"),
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  overrides: [{
    files: ["**/*.ts"],
    rules: { "error-code-policy/require-tagged-error-code": "error" },
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

  const runOxlint = (paths: readonly string[], extraArguments: readonly string[] = []) => {
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
        ...extraArguments,
      ],
      { cwd: fixtureRoot, encoding: "utf-8" },
    );

    return {
      output: `${result.stdout}${result.stderr}`,
      status: result.status ?? 1,
    };
  };

  it("reports missing, static, computed and mismatched codes", async () => {
    await writeFixture(
      "src/missing.ts",
      `export class InvoiceNotFoundError extends Data.TaggedError("InvoiceNotFoundError")<{
  readonly message: string;
}> {}\n`,
    );
    await writeFixture(
      "src/static.ts",
      `export class InvoiceConflictError extends Data.TaggedError("InvoiceConflictError")<{
  readonly message: string;
}> {
  static readonly code = "INVOICE_CONFLICT";
}\n`,
    );
    await writeFixture(
      "src/computed.ts",
      `export class InvoicePersistenceError extends Data.TaggedError("InvoicePersistenceError")<{
  readonly message: string;
}> {
  readonly code = buildCode();
}\n`,
    );
    await writeFixture(
      "src/mismatch.ts",
      `export class OpenBankingRateLimitError extends Data.TaggedError("OpenBankingRateLimitError")<{
  readonly message: string;
}> {
  readonly code = "RATE_LIMIT";
}\n`,
    );

    const result = runOxlint([
      "src/missing.ts",
      "src/static.ts",
      "src/computed.ts",
      "src/mismatch.ts",
    ]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/error-code-policy\(require-tagged-error-code\)/gu)?.length,
      4,
      result.output,
    );
    assert.match(result.output, /readonly code = "INVOICE_NOT_FOUND"/u);
    assert.match(result.output, /readonly code = "INVOICE_CONFLICT"/u);
    assert.match(result.output, /readonly code = "INVOICE_PERSISTENCE"/u);
    assert.match(result.output, /code 'RATE_LIMIT'/u);
    assert.match(result.output, /OPEN_BANKING_RATE_LIMIT/u);
  });

  it("allows a matching code and ignores other classes", async () => {
    await writeFixture(
      "src/valid.ts",
      `export class InvoiceXmlValidationError extends Data.TaggedError("InvoiceXmlValidationError")<{
  readonly message: string;
}> {
  readonly code = "INVOICE_XML_VALIDATION";
}

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly cause: unknown;
}> {
  readonly code = "DATABASE";
}

export class ApiNotFound extends Schema.TaggedError<ApiNotFound>()("ApiNotFound", {
  message: Schema.String,
}) {}

export class Plain extends Base {
  readonly value = 1;
}\n`,
    );

    const result = runOxlint(["src/valid.ts"]);

    assert.equal(result.status, 0, result.output);
  });

  it("fixes a missing and a mismatched code", async () => {
    await writeFixture(
      "src/fixable.ts",
      `export class PurchaseInboxFetchError extends Data.TaggedError("PurchaseInboxFetchError")<{
  readonly message: string;
}> {}

export class WorkerRegistrationError extends Data.TaggedError("WorkerRegistrationError")<{
  readonly message: string;
}> {
  readonly code = "WORKER";
}\n`,
    );

    const result = runOxlint(["src/fixable.ts"], ["--fix"]);
    assert.equal(result.status, 0, result.output);

    const fixed = await readFile(path.join(fixtureRoot, "src/fixable.ts"), "utf-8");
    assert.match(fixed, /readonly code = "PURCHASE_INBOX_FETCH";/u);
    assert.match(fixed, /readonly code = "WORKER_REGISTRATION";/u);
    assert.equal(runOxlint(["src/fixable.ts"]).status, 0);
  });
});
