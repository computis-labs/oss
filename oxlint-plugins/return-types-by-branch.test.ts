import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(import.meta.dirname);
const oxlint = path.join(repositoryRoot, "node_modules", ".bin", "oxlint");
const plugin = fileURLToPath(new URL("return-types-by-branch.ts", import.meta.url));

describe("return-type-policy/by-branch", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "return-types-by-branch-"));
    await writeFile(
      path.join(fixtureRoot, "oxlint.config.ts"),
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  rules: { "return-type-policy/by-branch": "error" },
};
`,
    );
  });

  afterAll(async () => {
    await rm(fixtureRoot, { force: true, recursive: true });
  });

  const runOxlint = async (source: string, fix = false) => {
    const fixture = path.join(fixtureRoot, "fixture.ts");
    await writeFile(fixture, source);

    const result = spawnSync(
      oxlint,
      ["fixture.ts", "--config", "oxlint.config.ts", "--format", "unix", ...(fix ? ["--fix"] : [])],
      { cwd: fixtureRoot, encoding: "utf-8" },
    );

    return {
      fixed: fix ? await readFile(fixture, "utf-8") : source,
      output: `${result.stdout}${result.stderr}`,
      status: result.status ?? 1,
    };
  };

  it("requires return types when branches return different value types", async () => {
    const result = await runOxlint(`
function fromIf(value: boolean) {
  if (value) return 1;
  return "no";
}
const fromSwitch = (value: string) => {
  switch (value) {
    case "yes": return true;
    default: return "no";
  }
};
const fromTernary = (value: boolean) => value ? [] : {};
`);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/return-type-policy\(by-branch\)/gu)?.length,
      3,
      result.output,
    );
    assert.match(result.output, /returns different value types/u);
  });

  it("allows branches whose return values have one type", async () => {
    const result = await runOxlint(`
const storage = {
  try: async () => {
    if (enabled) await upload();
    return "key";
  },
};
function choose(value: boolean) {
  if (value) return "yes";
  return "no";
}
const numeric = (value: boolean) => value ? 1 : 2;
const fallback = (value: string | null | undefined) => value ?? "";
const onlyNullish = (value: null | undefined) => value ?? null;
function format(value: Date | string) {
  const empty = "";
  return isString(value) ? value : empty;
}
`);

    assert.equal(result.status, 0, result.output);
  });

  it("requires a contract when an unresolved value falls back to null", async () => {
    const result = await runOxlint(`
const findPendingPreview = async () => {
  const [preview] = await selectPreview();
  return preview ?? null;
};
`);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/return-type-policy\(by-branch\)/gu)?.length,
      1,
      result.output,
    );
  });

  it("resolves local values before comparing returned types", async () => {
    const result = await runOxlint(`
function encode(enabled: boolean) {
  if (!enabled) return undefined;
  const base = {};
  const encoded = { ...base, code: "ok" };
  return encoded;
}
function choose(value: boolean) {
  const yes = "yes";
  if (value) return yes;
  const no = "no";
  return no;
}
`);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/return-type-policy\(by-branch\)/gu)?.length,
      1,
      result.output,
    );
  });

  it("compares returned object shapes instead of their property values", async () => {
    const result = await runOxlint(`
const valid = (value: boolean) => value
  ? { isFocused: true, latestUpdate: 1 }
  : { isFocused: false, latestUpdate: 2 };
const invalid = (value: boolean) => value
  ? { isFocused: true, latestUpdate: 1 }
  : { isFocused: false, latestupdate: 2 };
`);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/return-type-policy\(by-branch\)/gu)?.length,
      1,
      result.output,
    );
  });

  it("rejects return types when all paths return one value type", async () => {
    const result = await runOxlint(`
function choose(value: boolean): string {
  if (value) return "yes";
  return "no";
}
const length = (value: string): number => value.length;
const load = async (): Promise<string> => {
  if (enabled) await upload();
  return "key";
};
`);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/return-type-policy\(by-branch\)/gu)?.length,
      3,
      result.output,
    );
    assert.match(result.output, /returns one value type/u);
  });

  it("allows named contracts and recursive return annotations", async () => {
    const result = await runOxlint(`
interface Payload {
  readonly value: string;
}
const payload = (): Payload => ({ value: "ok" });
const payloads = (): Payload[] => [{ value: "ok" }];
const optionalPayload = (): Payload | undefined => currentPayload;
const pendingPayload = async (): Promise<Payload | undefined> => currentPayload;
function contains(values: readonly unknown[]): boolean {
  return values.some((value) => Array.isArray(value) && contains(value));
}
function serialize(values: readonly unknown[]): string {
  return values.map(serialize).join("");
}
`);

    assert.equal(result.status, 0, result.output);
  });

  it("allows an explicit contract for heterogeneous returns", async () => {
    const result = await runOxlint(`
function choose(value: boolean): string | number {
  if (value) return 1;
  return "no";
}
const toggle = (value: boolean): boolean | string => value ? false : "unknown";
`);

    assert.equal(result.status, 0, result.output);
  });

  it("checks each nested function independently", async () => {
    const result = await runOxlint(`
const outer = () => {
  const inner = (value: boolean) => value ? "yes" : 0;
  return inner;
};
`);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/return-type-policy\(by-branch\)/gu)?.length,
      1,
      result.output,
    );
  });

  it("allows type predicates and skips generators, constructors, and setters", async () => {
    const result = await runOxlint(`
const isString = (value: unknown): value is string => typeof value === "string";
function* choose(value: boolean) {
  if (value) yield "yes";
  return 1;
}
class Store {
  constructor(value: boolean) {
    if (value) consume(value);
  }
  set value(value: number) {
    if (value > 0) consume(value);
  }
}
const target = {
  set value(value: number) {
    if (value > 0) consume(value);
  },
};
`);

    assert.equal(result.status, 0, result.output);
  });

  it("removes unnecessary return types with a fix", async () => {
    const result = await runOxlint(
      `const choose = (value: boolean): string => value ? "yes" : "no";\n`,
      true,
    );

    assert.equal(result.status, 0, result.output);
    assert.equal(result.fixed, `const choose = (value: boolean) => value ? "yes" : "no";\n`);
  });
});
