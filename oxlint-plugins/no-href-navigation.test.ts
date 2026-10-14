import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(import.meta.dirname);
const oxlint = path.join(repositoryRoot, "node_modules", ".bin", "oxlint");
const plugin = fileURLToPath(new URL("no-href-navigation.ts", import.meta.url));

describe("router-policy/no-href-navigation", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "no-href-navigation-"));
    await writeFile(
      path.join(fixtureRoot, "oxlint.config.ts"),
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  overrides: [{
    files: ["apps/web/**/*.tsx"],
    rules: { "router-policy/no-href-navigation": ["error", { ignoreComponents: ["BrandMark"] }] },
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

  it("reports internal hrefs on components, template literals and native anchors", async () => {
    await writeFixture(
      "apps/web/src/literal.tsx",
      `export const A = () => <Button href="/pmi/fatture/nuova">Nuova</Button>;\n`,
    );
    await writeFixture(
      "apps/web/src/template.tsx",
      `export const B = ({ id }) => <Button href={\`/pmi/impostazioni/integrazioni/\${id}\`}>Configura</Button>;\n`,
    );
    await writeFixture(
      "apps/web/src/anchor.tsx",
      `export const C = () => <a href="/studio">Studio</a>;\n`,
    );

    const result = runOxlint([
      "apps/web/src/literal.tsx",
      "apps/web/src/template.tsx",
      "apps/web/src/anchor.tsx",
    ]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/router-policy\(no-href-navigation\)/gu)?.length,
      3,
      result.output,
    );
    assert.match(result.output, /renders a native anchor and reloads the whole app/u);
    assert.match(result.output, /triggers a full page reload/u);
  });

  it("allows external urls, non-http schemes, fragments, Link and ignored components", async () => {
    await writeFixture(
      "apps/web/src/external.tsx",
      `export const A = () => <Button href="https://computis.it">Sito</Button>;\n`,
    );
    await writeFixture(
      "apps/web/src/schemes.tsx",
      `export const B = () => (
  <>
    <a href="mailto:info@computis.it">Mail</a>
    <a href="tel:+390212345678">Tel</a>
    <a href="#section">Anchor</a>
    <a href="//cdn.example.com/x.pdf">Protocol relative</a>
  </>
);\n`,
    );
    await writeFixture(
      "apps/web/src/link.tsx",
      `export const C = () => <Button render={<Link to="/pmi/fatture/nuova" />}>Nuova</Button>;\n`,
    );
    await writeFixture(
      "apps/web/src/ignored.tsx",
      `export const D = () => <BrandMark href="/" />;\n`,
    );

    const result = runOxlint([
      "apps/web/src/external.tsx",
      "apps/web/src/schemes.tsx",
      "apps/web/src/link.tsx",
      "apps/web/src/ignored.tsx",
    ]);

    assert.equal(result.status, 0, result.output);
  });
});
