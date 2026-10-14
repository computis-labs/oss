import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "@effect/vitest";

const root = path.dirname(import.meta.dirname);

describe("test-boundary/no-test-imports", () => {
  let directory = "";
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "test-boundary-"));
    await writeFile(
      path.join(directory, "oxlint.config.ts"),
      `export default { jsPlugins: [${JSON.stringify(path.join(root, "oxlint-plugins/no-test-imports.ts"))}], rules: { "test-boundary/no-test-imports": "error" } };`,
    );
    await mkdir(path.join(directory, "src"));
  });
  afterAll(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  const check = async (file: string, source: string) => {
    await writeFile(path.join(directory, file), source);
    const result = spawnSync(
      path.join(root, "node_modules/.bin/oxlint"),
      [file, "--config", "oxlint.config.ts", "--format", "unix", "--threads", "1"],
      { cwd: directory, encoding: "utf-8" },
    );
    return { output: `${result.stdout}${result.stderr}`, status: result.status };
  };

  it("rejects static, dynamic and re-exported test dependencies", async () => {
    const result = await check(
      "src/service.ts",
      `import { one } from "#/test/harness";
export { two } from "./sample.fixtures";
export * from "./test-support";
export const load = () => import("@/test/fixture");
export const value = one;
`,
    );
    assert.notEqual(result.status, 0);
    assert.equal(
      result.output.match(/Production code must not import test support/gu)?.length,
      4,
      result.output,
    );
  });

  it("allows tests to use test support", async () => {
    const result = await check("src/service.test.ts", `export { one } from "#/test/harness";`);
    assert.equal(result.status, 0, result.output);
  });

  it("does not reject a production module with a similar name", async () => {
    const result = await check("src/service.ts", `export { latest } from "./latest-result";`);
    assert.equal(result.status, 0, result.output);
  });
});
