import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(import.meta.dirname);
const oxlint = path.join(repositoryRoot, "node_modules", ".bin", "oxlint");
const plugin = fileURLToPath(new URL("prefer-early-return.ts", import.meta.url));

describe("control-flow-policy/prefer-early-return", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "prefer-early-return-"));
    await writeFile(
      path.join(fixtureRoot, "oxlint.config.ts"),
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  rules: { "control-flow-policy/prefer-early-return": "error" },
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

  it("reports a guard nested in an if block that falls through", async () => {
    await writeFixture(
      "src/nested.ts",
      `export const deleteFolder = (fileCount: number, destination: string | null) => {
  if (fileCount > 0) {
    if (destination === null) {
      return "not-empty";
    }
    globalThis.console.log("move", destination);
  }
  return "deleted";
};

export const firstNamed = (names: readonly string[], wanted: string | undefined) => {
  if (wanted !== undefined) {
    const named = names.filter((name) => name === wanted);
    if (named.length === 1) {
      throw new Error("found");
    }
  }
  return names[0];
};

export const loop = (values: readonly number[]) => {
  for (const value of values) {
    if (value > 0) {
      if (value > 10) {
        continue;
      }
      globalThis.console.log(value);
    }
  }
};\n`,
    );

    const result = runOxlint(["src/nested.ts"]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/control-flow-policy\(prefer-early-return\)/gu)?.length,
      3,
      result.output,
    );
    assert.match(result.output, /Lift this guard out of the enclosing `if`/u);
  });

  it("allows flat guards, branches that exit, if-else, and nested ifs without an exit", async () => {
    await writeFixture(
      "src/flat.ts",
      `export const deleteFolder = (fileCount: number, destination: string | null) => {
  if (fileCount > 0 && destination === null) {
    return "not-empty";
  }
  if (destination === null) {
    return "deleted";
  }
  return "moved";
};

export const branch = (kind: string, value: number) => {
  if (kind === "correction") {
    if (value < 0) {
      return "invalid";
    }
    return "corrected";
  }
  return "replaced";
};

export const withElse = (a: boolean, b: boolean) => {
  if (a) {
    if (b) {
      return 1;
    }
    globalThis.console.log("a");
  } else {
    globalThis.console.log("not a");
  }
  return 0;
};

export const exhaustiveSwitch = (loop: string | null, name: "index" | "first") => {
  if (name.length > 0) {
    if (loop === null) {
      return "outside";
    }
    switch (name) {
      case "index":
      case "first": {
        return loop;
      }
      default: {
        return "never";
      }
    }
  }
  return "root";
};

export const bothBranchesExit = (a: boolean, b: boolean) => {
  if (a) {
    if (b) {
      return 1;
    }
    if (a === b) {
      return 2;
    } else {
      return 3;
    }
  }
  return 0;
};

export const sideEffects = (a: boolean, b: boolean) => {
  if (a) {
    globalThis.console.log("a");
    if (b) {
      globalThis.console.log("b");
    }
  }
};\n`,
    );

    const result = runOxlint(["src/flat.ts"]);

    assert.equal(result.status, 0, result.output);
  });
});
