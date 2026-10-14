import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(import.meta.dirname);
const oxlint = path.join(repositoryRoot, "node_modules", ".bin", "oxlint");
const plugin = fileURLToPath(new URL("no-app-local-data-table.ts", import.meta.url));

describe("data-table-policy/no-app-local-data-table", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "no-app-local-data-table-"));
    await writeFile(
      path.join(fixtureRoot, "oxlint.config.ts"),
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  overrides: [{
    files: ["apps/web/**/*.{ts,tsx}"],
    rules: {
      "data-table-policy/no-app-local-data-table": ["error", {
        allowedPaths: ["src/mock-table.tsx"],
        stateOwnerPaths: ["src/use-server-data-table-query.ts"],
      }],
    },
  }],
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

    return { output: `${result.stdout}${result.stderr}`, status: result.status ?? 1 };
  };

  it("rejects local application tables", async () => {
    await writeFixture(
      "apps/web/src/live-table.tsx",
      `import { useDataTable, useLocalDataTable } from "@computis/design-system/components/data-table";\n`,
    );

    const result = runOxlint(["apps/web/src/live-table.tsx"]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/data-table-policy\(no-app-local-data-table\)/gu)?.length,
      2,
      result.output,
    );
  });

  it("rejects direct server table state wiring", async () => {
    await writeFixture(
      "apps/web/src/live-table.tsx",
      `import { useDataTableState } from "@computis/design-system/components/data-table";\n`,
    );

    const result = runOxlint(["apps/web/src/live-table.tsx"]);

    assert.equal(result.status, 1);
    assert.match(result.output, /useServerDataTableQuery/u);
  });

  it("allows server tables, the standard query hook, and reviewed finite tables", async () => {
    await writeFixture(
      "apps/web/src/server-table.tsx",
      `import { useServerDataTable } from "@computis/design-system/components/data-table";\n`,
    );
    await writeFixture(
      "apps/web/src/use-server-data-table-query.ts",
      `import { useDataTableState } from "@computis/design-system/components/data-table";\n`,
    );
    await writeFixture(
      "apps/web/src/mock-table.tsx",
      `import { useLocalDataTable } from "@computis/design-system/components/data-table";\n`,
    );

    const result = runOxlint([
      "apps/web/src/server-table.tsx",
      "apps/web/src/use-server-data-table-query.ts",
      "apps/web/src/mock-table.tsx",
    ]);

    assert.equal(result.status, 0, result.output);
  });
});
