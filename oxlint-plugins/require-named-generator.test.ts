import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(import.meta.dirname);
const oxlint = path.join(repositoryRoot, "node_modules", ".bin", "oxlint");
const plugin = fileURLToPath(new URL("require-named-generator.ts", import.meta.url));

describe("generator-policy/require-named-generator", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "require-named-generator-"));
    await writeFile(
      path.join(fixtureRoot, "oxlint.config.ts"),
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  overrides: [
    {
      files: ["src/allowed/**"],
      rules: {
        "generator-policy/require-named-generator": ["error", { allowUnnamedGenerators: true }],
      },
    },
  ],
  rules: { "generator-policy/require-named-generator": "error" },
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

  const anonymousGenerator = `export const program = Effect.gen(function* () {
  yield* step;
});\n`;

  it("reports an anonymous generator in shipped code", async () => {
    await writeFixture("src/worker.ts", anonymousGenerator);

    const result = runOxlint(["src/worker.ts"]);

    assert.equal(result.status, 1);
    assert.match(result.output, /Name this generator/u);
  });

  it("accepts a named generator", async () => {
    await writeFixture(
      "src/named.ts",
      `export const program = Effect.gen(function* workerProgram() {
  yield* step;
});\n`,
    );

    const result = runOxlint(["src/named.ts"]);

    assert.equal(result.status, 0, result.output);
  });

  it("allows an anonymous generator where allowUnnamedGenerators is set", async () => {
    await writeFixture("src/allowed/harness.ts", anonymousGenerator);

    const result = runOxlint(["src/allowed/harness.ts"]);

    assert.equal(result.status, 0, result.output);
  });

  it("reports an anonymous function expression even where generators are allowed", async () => {
    await writeFixture(
      "src/allowed/callback.ts",
      `export const run = register(function () {
  return 1;
});\n`,
    );

    const result = runOxlint(["src/allowed/callback.ts"]);

    assert.equal(result.status, 1);
    assert.match(result.output, /Name this function expression/u);
  });

  it("ignores methods, which take their name from their key", async () => {
    await writeFixture(
      "src/methods.ts",
      `export class Client {
  constructor() {
    this.ready = true;
  }

  send() {
    return this.ready;
  }
}

export const handlers = {
  onOpen() {
    return true;
  },
};\n`,
    );

    const result = runOxlint(["src/methods.ts"]);

    assert.equal(result.status, 0, result.output);
  });
});
