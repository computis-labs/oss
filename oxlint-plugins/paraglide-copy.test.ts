import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(import.meta.dirname);
const oxlint = path.join(repositoryRoot, "node_modules", ".bin", "oxlint");
const plugin = fileURLToPath(new URL("paraglide-copy.ts", import.meta.url));

describe("paraglide-copy/no-raw-copy", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "paraglide-copy-"));
    await writeFile(
      path.join(fixtureRoot, "oxlint.config.ts"),
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  rules: { "paraglide-copy/no-raw-copy": "error" },
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

  const componentSource = `export const Save = () => (
  <button title="Salva le modifiche">Salva</button>
);\n`;

  it("reports copy in JSX text and in a copy attribute", async () => {
    await writeFixture("src/save.tsx", componentSource);

    const result = runOxlint(["src/save.tsx"]);

    assert.equal(result.status, 1);
    assert.equal(result.output.match(/paraglide-copy\(no-raw-copy\)/gu)?.length, 2, result.output);
  });

  it("reports copy hidden in a child expression", async () => {
    await writeFixture(
      "src/child-expression.tsx",
      `export const Greeting = ({ name }: { name: string }) => (
  <p>
    {"Ciao"}
    {\`Bentornato \${name}\`}
  </p>
);\n`,
    );

    const result = runOxlint(["src/child-expression.tsx"]);

    assert.equal(result.status, 1);
    assert.equal(result.output.match(/paraglide-copy\(no-raw-copy\)/gu)?.length, 2, result.output);
  });

  it("reports copy hidden in a branch of a copy attribute", async () => {
    await writeFixture(
      "src/branch.tsx",
      `export const Save = ({ saved, name }: { saved: boolean; name: string }) => (
  <button aria-label={saved ? "Salvato" : "Salva"} title={name || "Senza nome"} />
);\n`,
    );

    const result = runOxlint(["src/branch.tsx"]);

    assert.equal(result.status, 1);
    assert.equal(result.output.match(/paraglide-copy\(no-raw-copy\)/gu)?.length, 2, result.output);
  });

  it("allows a message call in a branch", async () => {
    await writeFixture(
      "src/branch-ok.tsx",
      `export const Save = ({ saved }: { saved: boolean }) => (
  <button aria-label={saved ? m.saved() : m.save()} />
);\n`,
    );

    const result = runOxlint(["src/branch-ok.tsx"]);

    assert.equal(result.status, 0, result.output);
  });

  it("ignores strings with no letters", async () => {
    await writeFixture("src/count.tsx", `export const Count = () => <span title="42">—</span>;\n`);

    const result = runOxlint(["src/count.tsx"]);

    assert.equal(result.status, 0, result.output);
  });
});

describe("paraglide-copy/no-branching-copy", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "paraglide-branching-copy-"));
    await writeFile(
      path.join(fixtureRoot, "oxlint.config.ts"),
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  rules: { "paraglide-copy/no-branching-copy": "error" },
};\n`,
    );
  });

  afterAll(async () => {
    await rm(fixtureRoot, { force: true, recursive: true });
  });

  const lint = async (source: string) => {
    const destination = path.join(fixtureRoot, "src", "copy.tsx");
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, `import { m } from "@/paraglide/messages";\n${source}`);
    const result = spawnSync(
      oxlint,
      ["src/copy.tsx", "--config", "oxlint.config.ts", "--format", "unix", "--threads", "1"],
      { cwd: fixtureRoot, encoding: "utf-8" },
    );
    const output = `${result.stdout}${result.stderr}`;

    return {
      output,
      reports: output.match(/paraglide-copy\(no-branching-copy\)/gu)?.length ?? 0,
    };
  };

  it("reports a ternary between two messages", async () => {
    const result = await lint(
      `export const label = (pending: boolean) => (pending ? m.saving() : m.save());\n`,
    );

    assert.equal(result.reports, 1, result.output);
  });

  it("reports a chain of ternaries between messages once", async () => {
    const result = await lint(
      `export const label = (count: number) =>
  count === 0 ? m.none() : count === 1 ? m.one() : m.many({ count });\n`,
    );

    assert.equal(result.reports, 1, result.output);
  });

  it("reports an if that returns a message before a return of another message", async () => {
    const result = await lint(
      `export const label = (count: number) => {
  if (count === 0) {
    return m.none();
  }
  return m.many({ count });
};\n`,
    );

    assert.equal(result.reports, 1, result.output);
  });

  it("reports an if and else that each return a message", async () => {
    const result = await lint(
      `export const label = (open: boolean) => {
  if (open) {
    return m.close();
  } else {
    return m.open();
  }
};\n`,
    );

    assert.equal(result.reports, 1, result.output);
  });

  it("allows a ternary between a message and a value", async () => {
    const result = await lint(
      `export const label = (name: string | undefined) => (name === undefined ? m.nobody() : name);\n`,
    );

    assert.equal(result.reports, 0, result.output);
  });

  it("allows a guard that returns a message before a return of no copy", async () => {
    const result = await lint(
      `export const refusal = (size: number) => {
  if (size > 10) {
    return m.too_large();
  }
  return null;
};\n`,
    );

    assert.equal(result.reports, 0, result.output);
  });

  it("allows a ternary between calls on another object", async () => {
    const result = await lint(
      `const t = { a: () => "a", b: () => "b" };
export const label = (flag: boolean) => (flag ? t.a() : t.b());\n`,
    );

    assert.equal(result.reports, 0, result.output);
  });
});
