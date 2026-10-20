import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(import.meta.dirname);
const oxlint = path.join(repositoryRoot, "node_modules", ".bin", "oxlint");
const plugin = fileURLToPath(new URL("no-string-literal-comparison.ts", import.meta.url));
const rule = "literal-policy/no-string-literal-comparison";

describe(rule, () => {
  let fixtureRoot = "";

  const writeFixture = async (relativePath: string, source: string) => {
    const destination = path.join(fixtureRoot, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, source);
  };

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "string-literal-comparison-"));
    await writeFixture(
      "default.config.ts",
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  rules: { ${JSON.stringify(rule)}: "error" },
};
`,
    );
    await writeFixture(
      "options.config.ts",
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  rules: {
    ${JSON.stringify(rule)}: [
      "error",
      {
        allowEmptyString: false,
        allowNumericLiterals: true,
        allowPathLiterals: true,
        allowTypeofChecks: false,
        allowUppercaseLiterals: true,
        allowedLiterals: ["legacy"],
      },
    ],
  },
};
`,
    );
  });

  afterAll(async () => {
    await rm(fixtureRoot, { force: true, recursive: true });
  });

  const runOxlint = (config: string, file: string) => {
    const result = spawnSync(
      oxlint,
      [file, "--config", config, "--format", "unix", "--threads", "1"],
      { cwd: fixtureRoot, encoding: "utf-8" },
    );

    return {
      output: `${result.stdout}${result.stderr}`,
      reports: result.stdout.match(/literal-policy\(no-string-literal-comparison\)/gu)?.length ?? 0,
      status: result.status ?? 1,
    };
  };

  it("reports an equality check against a string literal, on either side", async () => {
    await writeFixture(
      "src/flagged.ts",
      `export const checks = (status: string) => [
  status === "running",
  "running" !== status,
  status == "done",
  status != "done",
  status === \`failed\`,
];\n`,
    );

    const result = runOxlint("default.config.ts", "src/flagged.ts");

    assert.equal(result.status, 1);
    assert.equal(result.reports, 5, result.output);
    assert.match(result.output, /Do not compare against the string literal "running"/u);
  });

  it("allows a comparison against a named constant, two literals, or a template with values", async () => {
    await writeFixture(
      "src/constants.ts",
      `const statuses = { running: "running" } as const;

export const checks = (status: string, suffix: string) => [
  status === statuses.running,
  "a" === "b",
  status === \`run-\${suffix}\`,
  status < "m",
];\n`,
    );

    const result = runOxlint("default.config.ts", "src/constants.ts");

    assert.equal(result.status, 0, result.output);
  });

  it("allows the empty string and a typeof check by default", async () => {
    await writeFixture(
      "src/defaults.ts",
      `export const checks = (value: unknown, text: string) => [
  text === "",
  typeof value === "string",
];\n`,
    );

    const result = runOxlint("default.config.ts", "src/defaults.ts");

    assert.equal(result.status, 0, result.output);
  });

  it("reports the empty string and a typeof check when their options are off", async () => {
    await writeFixture(
      "src/defaults-off.ts",
      `export const checks = (value: unknown, text: string) => [
  text === "",
  typeof value === "string",
];\n`,
    );

    const result = runOxlint("options.config.ts", "src/defaults-off.ts");

    assert.equal(result.status, 1);
    assert.equal(result.reports, 2, result.output);
  });

  it("reports numeric, path, uppercase and listed literals without their options", async () => {
    await writeFixture(
      "src/optional.ts",
      `export const checks = (value: string) => [
  value === "2024",
  value === "/fatture",
  value === "IT",
  value === "legacy",
];\n`,
    );

    const result = runOxlint("default.config.ts", "src/optional.ts");

    assert.equal(result.status, 1);
    assert.equal(result.reports, 4, result.output);
  });

  it("allows numeric, path, uppercase and listed literals with their options", async () => {
    await writeFixture(
      "src/optional-on.ts",
      `export const checks = (value: string) => [
  value === "2024",
  value === "1.2.3",
  value === "/fatture",
  value === "IT",
  value === "legacy",
];\n`,
    );

    const result = runOxlint("options.config.ts", "src/optional-on.ts");

    assert.equal(result.status, 0, result.output);
  });

  it("still reports a lowercase literal when every option is on", async () => {
    await writeFixture(
      "src/options-flagged.ts",
      `export const isRunning = (status: string) => status === "running";\n`,
    );

    const result = runOxlint("options.config.ts", "src/options-flagged.ts");

    assert.equal(result.status, 1);
    assert.equal(result.reports, 1, result.output);
  });
});
