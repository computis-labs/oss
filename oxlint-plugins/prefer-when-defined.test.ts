import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(import.meta.dirname);
const oxlint = path.join(repositoryRoot, "node_modules", ".bin", "oxlint");
const plugin = fileURLToPath(new URL("prefer-when-defined.ts", import.meta.url));

describe("object-policy/prefer-when-defined", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "prefer-when-defined-"));
    await writeFile(
      path.join(fixtureRoot, "oxlint.config.ts"),
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  rules: { "object-policy/prefer-when-defined": "error" },
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

  it("reports a choice between {} and an object keyed on a missing value", async () => {
    await writeFixture(
      "src/empty.ts",
      `declare const limit: number | undefined;
declare const owner: string | null;

export const a = { ...(limit === undefined ? {} : { take: limit }) };
export const b = { ...(limit !== undefined ? { take: limit } : {}) };
export const c = owner === null ? {} : { owner };
export const d = undefined == limit ? {} : { take: limit };\n`,
    );

    const result = runOxlint(["src/empty.ts"]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/object-policy\(prefer-when-defined\)/gu)?.length,
      4,
      result.output,
    );
    assert.match(result.output, /Spread the optional key with whenDefined/u);
  });

  it("reports a call written twice only to add an optional key", async () => {
    await writeFixture(
      "src/calls.ts",
      `declare const db: { find: (args?: object) => number; count: (args?: object) => number };
declare const limit: number | undefined;
declare const where: string | undefined;
const query = { skip: 0 };

export const a = limit === undefined ? db.find(query) : db.find({ ...query, take: limit });
export const b =
  limit === undefined ? db.find({ skip: 0 }) : db.find({ skip: 0, take: limit });
export const c = where === undefined ? db.count() : db.count({ where });\n`,
    );

    const result = runOxlint(["src/calls.ts"]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/object-policy\(prefer-when-defined\)/gu)?.length,
      3,
      result.output,
    );
    assert.match(result.output, /Both branches make the same call/u);
  });

  it("allows other conditions, different calls, and branches that are not a key choice", async () => {
    await writeFixture(
      "src/allowed.ts",
      `declare const db: { find: (args?: object) => number; count: (args?: object) => number };
declare const limit: number | undefined;
declare const option: string | null | undefined;
declare const freeText: boolean;

export const a = freeText || option === undefined ? {} : { value: option };
export const b = limit === undefined ? db.find({ skip: 0 }) : db.count({ skip: 0, take: limit });
export const c = limit === undefined ? undefined : { take: limit };
export const d = limit === undefined ? { take: 10 } : { take: limit };
export const e = limit === undefined ? db.find({ skip: 0 }) : db.find({ skip: 1 });
export const f = limit === 0 ? {} : { take: limit };\n`,
    );

    const result = runOxlint(["src/allowed.ts"]);

    assert.equal(result.status, 0, result.output);
  });
});
