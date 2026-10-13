import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(import.meta.dirname);
const oxlint = path.join(repositoryRoot, "node_modules", ".bin", "oxlint");
const plugin = fileURLToPath(new URL("no-discarded-iife.ts", import.meta.url));

describe("function-policy/no-discarded-iife", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "discarded-iife-"));
    await writeFile(
      path.join(fixtureRoot, "oxlint.config.ts"),
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  rules: { "function-policy/no-discarded-iife": "error" },
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

  it("reports a function built only to be called and thrown away", async () => {
    await writeFixture(
      "src/discarded.ts",
      `export const register = (schedule: (run: () => void) => void, stop: () => Promise<void>) => {
  schedule(() => {
    void (async () => {
      await stop();
    })();
  });
};

export const scope = () => {
  (() => {
    globalThis.console.log("side effect");
  })();
};

export const awaited = async (stop: () => Promise<void>) => {
  await (async () => {
    await stop();
  })();
};\n`,
    );

    const result = runOxlint(["src/discarded.ts"]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/function-policy\(no-discarded-iife\)/gu)?.length,
      3,
      result.output,
    );
    assert.match(result.output, /Do not build a function only to call it here/u);
  });

  it("allows an immediate call whose result is used", async () => {
    await writeFixture(
      "src/used.ts",
      `let cached: Promise<string> | undefined;

export const memo = (load: () => Promise<string>) => {
  cached ??= (async () => await load())();

  return cached;
};

export const value = (() => 1 + 1)();

export const passed = (run: (task: () => void) => void) => {
  run(() => {
    globalThis.console.log("side effect");
  });
};\n`,
    );

    const result = runOxlint(["src/used.ts"]);

    assert.equal(result.status, 0, result.output);
  });
});
