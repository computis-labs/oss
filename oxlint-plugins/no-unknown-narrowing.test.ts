import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(import.meta.dirname);
const oxlint = path.join(repositoryRoot, "node_modules", ".bin", "oxlint");
const plugin = fileURLToPath(new URL("no-unknown-narrowing.ts", import.meta.url));

describe("narrowing-policy/no-unknown-narrowing", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "unknown-narrowing-"));
    await symlink(
      path.join(repositoryRoot, "node_modules"),
      path.join(fixtureRoot, "node_modules"),
      "dir",
    );
    await writeFile(
      path.join(fixtureRoot, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          target: "ESNext",
        },
        include: ["src/**/*.ts"],
      }),
    );
    await writeFile(
      path.join(fixtureRoot, "oxlint.config.ts"),
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  rules: { "narrowing-policy/no-unknown-narrowing": "error" },
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

  it("reports Predicate, Array.isArray, in and String on an unknown parameter", async () => {
    await writeFixture(
      "src/unknown-parameter.ts",
      `import { Predicate } from "effect";

export const read = (value: unknown) => {
  if (Predicate.isReadonlyObject(value) && "id" in value && Predicate.isString(value.id)) {
    return value.id;
  }
  return Array.isArray(value) ? String(value) : null;
};
`,
    );

    const { output, status } = runOxlint(["src/unknown-parameter.ts"]);

    assert.notEqual(status, 0);
    assert.match(output, /Predicate\.isReadonlyObject narrows an `unknown`/u);
    assert.match(output, /`in` narrows an `unknown`/u);
    assert.match(output, /Predicate\.isString narrows an `unknown`/u);
    assert.match(output, /Array\.isArray narrows an `unknown`/u);
    assert.match(output, /String narrows an `unknown`/u);
  });

  it("reports a check on a catch binding and on a const declared unknown", async () => {
    await writeFixture(
      "src/catch-and-const.ts",
      `import { Predicate } from "effect";

export const run = (parse: () => unknown) => {
  try {
    const parsed: unknown = parse();
    return Predicate.isNumber(parsed) ? parsed : 0;
  } catch (error) {
    return Predicate.isString(error) ? error.length : 0;
  }
};
`,
    );

    const { output, status } = runOxlint(["src/catch-and-const.ts"]);

    assert.notEqual(status, 0);
    assert.equal(output.match(/narrows an `unknown`/gu)?.length, 2);
  });

  it("reports instanceof Error and JSON.parse anywhere", async () => {
    await writeFixture(
      "src/hatches.ts",
      `export const message = (error: Error | string) =>
  error instanceof Error ? error.message : error;

export const parse = (text: string) => JSON.parse(text);
`,
    );

    const { output, status } = runOxlint(["src/hatches.ts"]);

    assert.notEqual(status, 0);
    assert.match(output, /`instanceof Error` reads a shape/u);
    assert.match(output, /`JSON\.parse` answers `any`/u);
  });

  it("accepts the same checks on a known union", async () => {
    await writeFixture(
      "src/known-union.ts",
      `import { Predicate } from "effect";

type Field = string | { readonly path: string };

export const pathOf = (field: Field) => (Predicate.isString(field) ? field : field.path);

export const toList = (value: string | readonly string[]) =>
  Array.isArray(value) ? value : [value];

export const hasHref = (action: { href: string } | { onClick: () => void }) => "href" in action;

export const label = (count: number) => String(count);
`,
    );

    const { output, status } = runOxlint(["src/known-union.ts"]);

    assert.equal(status, 0, output);
  });

  it("resolves the nearest declaration, so a shadowed name is judged by its own scope", async () => {
    await writeFixture(
      "src/shadowed.ts",
      `import { Predicate } from "effect";

export const outer = (value: unknown) => {
  const inner = (value: string | number) => Predicate.isString(value);
  return inner(1);
};

export const typed = (error: { readonly message: string }) => Predicate.isString(error.message);
`,
    );

    const { output, status } = runOxlint(["src/shadowed.ts"]);

    assert.equal(status, 0, output);
  });

  it("reports inferred inputs, aliases, properties and callbacks", async () => {
    await writeFixture("src/input.ts", `export declare const read: () => unknown;`);
    await writeFixture(
      "src/inferred.ts",
      `import { Predicate } from "effect";
import { read } from "./input";
export const inferred = () => Predicate.isReadonlyObject(read());
export const alias = (error: unknown) => { const copy = error; return Predicate.isReadonlyObject(copy); };
export const property = (input: { value: unknown }) => Predicate.isString(input.value);
export const callback = () => Promise.resolve(read()).then(value => Predicate.isString(value));
`,
    );
    const { output, status } = runOxlint(["src/inferred.ts"]);
    assert.notEqual(status, 0);
    assert.equal(output.match(/narrows an `unknown`/gu)?.length, 4, output);
  });

  it("resolves imported, destructured and computed checks", async () => {
    await writeFixture(
      "src/aliases.ts",
      `import { Predicate as P } from "effect";
import { isString as text } from "effect/Predicate";
const check = P.isReadonlyObject;
const { isArray: array } = Array;
const { parse } = JSON;
export const aliased = (error: unknown) => [P.isReadonlyObject(error), text(error), check(error), array(error), P["isString"](error)];
export const json = (input: string): unknown => parse(input);
`,
    );
    const { output, status } = runOxlint(["src/aliases.ts"]);
    assert.notEqual(status, 0);
    assert.equal(output.match(/narrows an `unknown`/gu)?.length, 5, output);
    assert.match(output, /`JSON\.parse` answers `any`/u);
  });

  it("rejects handwritten predicates and assertions over unknown inputs", async () => {
    await writeFixture(
      "src/predicates.ts",
      `export const claimed = (error: unknown): error is { id: string } => error !== null;
export function asserted(error: unknown): asserts error is string { if (error === null) throw new Error("null"); }
type Input = { value: unknown }["value"];
export const aliased = (error: Input): error is number => error !== null;
`,
    );
    const { output, status } = runOxlint(["src/predicates.ts"]);
    assert.notEqual(status, 0);
    assert.equal(output.match(/predicate over an unresolved input/gu)?.length, 3, output);
  });

  it("accepts schema guards and checks on decoded values", async () => {
    await writeFixture(
      "src/decoded.ts",
      `import { Predicate, Schema } from "effect";
const Field = Schema.Union([Schema.String, Schema.Number]);
export const isField = Schema.is(Field);
export const decoded = (error: unknown) => Predicate.isString(Schema.decodeUnknownSync(Field)(error));
export const narrowed = (error: unknown) => isField(error) ? Predicate.isString(error) : false;
`,
    );
    const { output, status } = runOxlint(["src/decoded.ts"]);
    assert.equal(status, 0, output);
  });

  it("does not mistake local names for library checks", async () => {
    await writeFixture(
      "src/local.ts",
      `const Predicate = { isReadonlyObject: (error: unknown) => error === null };
const JSON = { parse: (text: string) => text };
export const read = (error: unknown) => Predicate.isReadonlyObject(error);
export const parse = JSON.parse;
`,
    );
    const { output, status } = runOxlint(["src/local.ts"]);
    assert.equal(status, 0, output);
  });

  it("accepts explicit predicates over known unions and generic collections", async () => {
    await writeFixture(
      "src/known-predicates.ts",
      `export const hasText = (value: string | null): value is string => value !== null;
export const isArray = <T>(value: T | readonly T[]): value is readonly T[] => Array.isArray(value);
`,
    );
    const { output, status } = runOxlint(["src/known-predicates.ts"]);
    assert.equal(status, 0, output);
  });

  it("accepts instanceof on a domain error class", async () => {
    await writeFixture(
      "src/domain-error.ts",
      `class NotFoundError extends Error {}

export const isNotFound = (error: NotFoundError | TypeError) => error instanceof NotFoundError;
`,
    );

    const { output, status } = runOxlint(["src/domain-error.ts"]);

    assert.equal(status, 0, output);
  });
});
