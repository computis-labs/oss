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

describe("object-policy/no-membership-set", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "no-membership-set-"));
    await writeFile(
      path.join(fixtureRoot, "oxlint.config.ts"),
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  rules: { "object-policy/no-membership-set": "error" },
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

  it("reports a Set in a function that is only read with .has", async () => {
    await writeFixture(
      "src/function-set.ts",
      `declare const rows: readonly { readonly id: string; readonly kind: string }[];

export const readable = (kinds: readonly string[]) => {
  const allowed = new Set(kinds);
  return rows.filter((row) => allowed.has(row.kind));
};

export const both = (ids: readonly string[]) => {
  const known = new Set<string>(ids);
  return known.has("a") && !known.has("b");
};\n`,
    );

    const result = runOxlint(["src/function-set.ts"]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/object-policy\(no-membership-set\)/gu)?.length,
      2,
      result.output,
    );
    assert.match(result.output, /This Set is only used for \.has/u);
  });

  it("reports a module-level Set that is only read with .has", async () => {
    await writeFixture(
      "src/module-set.ts",
      `const safeMethods: ReadonlySet<string> = new Set(["GET", "HEAD"]);

export const isSafe = (method: string) => safeMethods.has(method);\n`,
    );

    const result = runOxlint(["src/module-set.ts"]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/object-policy\(no-membership-set\)/gu)?.length,
      1,
      result.output,
    );
  });

  it("allows a Set that is written, sized, spread, passed on, exported, unused, or not the global Set", async () => {
    await writeFixture(
      "src/allowed-set.ts",
      `declare const names: readonly string[];
declare const keep: (values: ReadonlySet<string>) => void;

export const exported = new Set(["a"]);

export const seen = (values: readonly string[]) => {
  const found = new Set<string>();
  for (const value of values) {
    if (!found.has(value)) {
      found.add(value);
    }
  }
  return found.size;
};

export const hasDuplicate = () => new Set(names).size !== names.length;

export const unique = () => {
  const distinct = new Set(names);
  return distinct.has("a") ? [...distinct] : [];
};

export const passed = () => {
  const passedOn = new Set(names);
  keep(passedOn);
  return passedOn.has("a");
};

export const unused = () => {
  const ignored = new Set(names);
  return names.length;
};

export const shadowed = () => {
  class Set {
    has(value: string) {
      return value.length > 0;
    }
  }
  const local = new Set();
  return local.has("a");
};\n`,
    );

    const result = runOxlint(["src/allowed-set.ts"]);

    assert.equal(result.status, 0, result.output);
  });

  it("reports a Map built from rows.map that is read with one .get or .has", async () => {
    await writeFixture(
      "src/map.ts",
      `declare const rows: readonly { readonly id: string; readonly amount: number }[];
declare const wanted: readonly string[];

export const amounts = () => {
  const amountById = new Map(rows.map((row) => [row.id, row.amount]));
  return wanted.map((id) => amountById.get(id) ?? 0);
};

export const present = (id: string) => {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return byId.has(id);
};\n`,
    );

    const result = runOxlint(["src/map.ts"]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/object-policy\(no-membership-set\)/gu)?.length,
      2,
      result.output,
    );
    assert.match(result.output, /This Map is read with one \.get or \.has/u);
  });

  it("allows a Map read in more than one place, written, or not built from rows.map", async () => {
    await writeFixture(
      "src/allowed-map.ts",
      `declare const rows: readonly { readonly id: string; readonly amount: number }[];

export const twice = (left: string, right: string) => {
  const amountById = new Map(rows.map((row) => [row.id, row.amount]));
  return (amountById.get(left) ?? 0) + (amountById.get(right) ?? 0);
};

export const written = (id: string) => {
  const byId = new Map(rows.map((row) => [row.id, row.amount]));
  byId.set(id, 0);
  return byId.get(id);
};

export const literal = (key: string) => {
  const labels = new Map([["a", "A"]]);
  return labels.get(key);
};

export const counted = () => {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return byId.size;
};\n`,
    );

    const result = runOxlint(["src/allowed-map.ts"]);

    assert.equal(result.status, 0, result.output);
  });
});
