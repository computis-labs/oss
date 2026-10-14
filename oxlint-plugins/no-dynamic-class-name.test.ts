import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(import.meta.dirname);
const oxlint = path.join(repositoryRoot, "node_modules", ".bin", "oxlint");
const plugin = fileURLToPath(new URL("no-dynamic-class-name.ts", import.meta.url));

describe("class-name-policy/no-dynamic-class-name", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "no-dynamic-class-name-"));
    await writeFile(
      path.join(fixtureRoot, "oxlint.config.ts"),
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  overrides: [{
    files: ["apps/web/**/*.tsx", "packages/ds/**/*.tsx"],
    rules: { "class-name-policy/no-dynamic-class-name": "error" },
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

    return {
      output: `${result.stdout}${result.stderr}`,
      status: result.status ?? 1,
    };
  };

  it("reports templates, concatenation, conditionals and logical expressions", async () => {
    await writeFixture(
      "apps/web/src/template.tsx",
      `export const A = ({ columns }) => <div className={\`grid gap-4 \${columns}\`} />;\n`,
    );
    await writeFixture(
      "apps/web/src/concatenation.tsx",
      `export const B = ({ extra }) => <div className={"grid " + extra} />;\n`,
    );
    await writeFixture(
      "packages/ds/src/conditional.tsx",
      `export const C = ({ open }) => <div className={open ? "block" : "hidden"} />;\n`,
    );
    await writeFixture(
      "packages/ds/src/logical.tsx",
      `export const D = ({ open }) => <div contentClassName={open && "block"} />;\n`,
    );

    const result = runOxlint([
      "apps/web/src/template.tsx",
      "apps/web/src/concatenation.tsx",
      "packages/ds/src/conditional.tsx",
      "packages/ds/src/logical.tsx",
    ]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/class-name-policy\(no-dynamic-class-name\)/gu)?.length,
      4,
      result.output,
    );
    assert.match(result.output, /template literal/u);
    assert.match(result.output, /concatenate class names/u);
  });

  it("allows literals, references and calls", async () => {
    await writeFixture(
      "apps/web/src/allowed.tsx",
      `export const A = ({ open, size }) => (
  <>
    <div className="grid gap-4" />
    <div className={cn("grid gap-4", open && "is-open")} />
    <div className={headingVariants({ size })} />
    <div className={surfaceClassName} />
    <div className={sizeClass[size]} />
  </>
);\n`,
    );

    const result = runOxlint(["apps/web/src/allowed.tsx"]);

    assert.equal(result.status, 0, result.output);
  });
});
