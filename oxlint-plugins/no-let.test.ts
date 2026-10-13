import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, it } from "@effect/vitest";

const repositoryRoot = path.dirname(import.meta.dirname);
const oxlint = path.join(repositoryRoot, "node_modules", ".bin", "oxlint");
const plugin = fileURLToPath(new URL("no-let.ts", import.meta.url));
const fixtureRoot = await mkdtemp(path.join(tmpdir(), "no-let-"));

await writeFile(
  path.join(fixtureRoot, "oxlint.config.ts"),
  `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  rules: { "variable-policy/no-let": "error" },
};\n`,
);

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

  return { output: `${result.stdout}${result.stderr}`, status: result.status ?? 1 };
};

describe("variable-policy/no-let", () => {
  afterAll(async () => {
    await rm(fixtureRoot, { force: true, recursive: true });
  });

  it("reports let declarations, including for-of, for-in and uninitialized ones", async () => {
    await writeFixture(
      "src/reassign.ts",
      `export const total = (values: readonly number[]) => {
  let sum = 0;
  for (let value of values) {
    sum += value;
  }
  return sum;
};
export const keys = (record: Record<string, number>) => {
  let found: string | undefined;
  for (let key in record) {
    found = key;
  }
  return found;
};\n`,
    );

    const result = runOxlint(["src/reassign.ts"]);

    assert.equal(result.status, 1);
    assert.equal(result.output.match(/variable-policy\(no-let\)/gu)?.length, 4, result.output);
  });

  it("allows const and the counter of a classic for loop", async () => {
    await writeFixture(
      "src/counter.ts",
      `export const evens = (limit: number) => {
  const found: number[] = [];
  for (let index = 0; index < limit; index += 2) {
    found.push(index);
  }
  return found;
};\n`,
    );

    const result = runOxlint(["src/counter.ts"]);

    assert.equal(result.status, 0, result.output);
  });
});
