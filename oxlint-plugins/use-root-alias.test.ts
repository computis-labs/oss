import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(import.meta.dirname);
const oxlint = path.join(repositoryRoot, "node_modules", ".bin", "oxlint");
const plugin = fileURLToPath(new URL("use-root-alias.ts", import.meta.url));

describe("import-policy", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "use-root-alias-"));
    await writeFile(
      path.join(fixtureRoot, "oxlint.config.ts"),
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  overrides: [
    {
      files: ["apps/backend/**"],
      rules: { "import-policy/use-root-alias": ["error", { alias: "#/" }] },
    },
  ],
  rules: {
    "import-policy/use-root-alias": "error",
    "import-policy/no-design-system-internals": "error",
  },
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

  const relativeImport = `import { thing } from "../lib/thing";\n\nexport const use = thing;\n`;

  it("asks for the @/ alias by default", async () => {
    await writeFixture("apps/web/src/pages/home.ts", relativeImport);

    const result = runOxlint(["apps/web/src/pages/home.ts"]);

    assert.equal(result.status, 1);
    assert.match(result.output, /through the `@\/` alias/u);
  });

  it("asks for the alias the override names", async () => {
    await writeFixture("apps/backend/src/routes/get.ts", relativeImport);

    const result = runOxlint(["apps/backend/src/routes/get.ts"]);

    assert.equal(result.status, 1);
    assert.match(result.output, /through the `#\/` alias/u);
  });

  it("reports a design-system primitive imported by an app", async () => {
    await writeFixture(
      "apps/web/src/page.ts",
      `import { Button } from "@computis/design-system/components/ui/button";\n\nexport const b = Button;\n`,
    );

    const result = runOxlint(["apps/web/src/page.ts"]);

    assert.equal(result.status, 1);
    assert.match(result.output, /Import the public component/u);
  });

  it("reports the table library outside the design system", async () => {
    await writeFixture(
      "apps/web/src/table.ts",
      `import { useReactTable } from "@tanstack/react-table";\n\nexport const t = useReactTable;\n`,
    );

    const result = runOxlint(["apps/web/src/table.ts"]);

    assert.equal(result.status, 1);
    assert.match(result.output, /design-system data table/u);
  });
});
