import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(import.meta.dirname);
const oxlint = path.join(repositoryRoot, "node_modules", ".bin", "oxlint");
const plugin = fileURLToPath(
  new URL("no-inline-match-query-status-components.ts", import.meta.url),
);

describe("query-status-policy/folder-structure", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "query-status-folder-structure-"));
    await writeFile(
      path.join(fixtureRoot, "oxlint.config.ts"),
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  overrides: [{
    files: ["apps/web/**/*.{ts,tsx}"],
    rules: { "query-status-policy/folder-structure": "error" },
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

  it("allows state components grouped in one folder with state file names", async () => {
    await writeFixture(
      "apps/web/src/ok.tsx",
      `import { matchQueryStatus } from "@/lib/match-query-status";
import { InvoicesEmpty } from "@/modules/invoices/empty";
import { InvoicesErrored } from "@/modules/invoices/errored";
import { InvoicesLoading } from "@/modules/invoices/loading";
import { InvoicesSuccess } from "@/modules/invoices/success";
export const Page = ({ query }: { query: never }) =>
  matchQueryStatus(query, {
    Empty: <InvoicesEmpty />,
    renderErrored: (error) => <InvoicesErrored error={error} />,
    Loading: InvoicesLoading,
    renderSuccess: (result) => <InvoicesSuccess data={result.data} />,
  });
`,
    );
    await writeFixture(
      "apps/web/src/partial.tsx",
      `import { matchQueryStatus } from "@/lib/match-query-status";
import { InvoicesErrored } from "@/modules/invoices/errored";
import { InvoicesLoading } from "@/modules/invoices/loading";
import { InvoicesSuccess } from "@/modules/invoices/success";
export const Page = ({ query }: { query: never }) =>
  matchQueryStatus(query, {
    Empty: <InvoicesLoading />,
    renderErrored: <InvoicesErrored />,
    Loading: <InvoicesLoading />,
    renderSuccess: (result) => <InvoicesSuccess data={result.data} />,
  });
`,
    );
    await writeFixture(
      "apps/web/src/relative.tsx",
      `import { matchQueryStatus } from "@/lib/match-query-status";
import { InvoicesErrored } from "./invoices/errored";
import { InvoicesLoading } from "./invoices/loading";
import { InvoicesSuccess } from "./invoices/success";
export const Page = ({ query }: { query: never }) =>
  matchQueryStatus(query, {
    renderErrored: <InvoicesErrored />,
    Loading: <InvoicesLoading />,
    renderSuccess: () => matchQueryStatus(query, {
      renderErrored: <InvoicesErrored />,
      Loading: <InvoicesLoading />,
      renderSuccess: (result) => <InvoicesSuccess data={result.data} />,
    }),
  });
`,
    );

    const result = runOxlint([
      "apps/web/src/ok.tsx",
      "apps/web/src/partial.tsx",
      "apps/web/src/relative.tsx",
    ]);

    assert.equal(result.status, 0, result.output);
  });

  it("reports state components with a file name outside the state set", async () => {
    await writeFixture(
      "apps/web/src/bad-name.tsx",
      `import { matchQueryStatus } from "@/lib/match-query-status";
import { InvoicesError } from "@/modules/invoices/error";
import { InvoicesLoading } from "@/modules/invoices/loading";
import { InvoicesList } from "@/modules/invoices/list";
export const Page = ({ query }: { query: never }) =>
  matchQueryStatus(query, {
    renderErrored: (error) => <InvoicesError error={error} />,
    Loading: <InvoicesLoading />,
    renderSuccess: (result) => <InvoicesList data={result.data} />,
  });
`,
    );

    const result = runOxlint(["apps/web/src/bad-name.tsx"]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/query-status-policy\(folder-structure\)/gu)?.length,
      2,
      result.output,
    );
    assert.match(result.output, /The renderErrored state renders InvoicesError from "error"/u);
    assert.match(result.output, /The renderSuccess state renders InvoicesList from "list"/u);
  });

  it("reports state components spread across folders", async () => {
    await writeFixture(
      "apps/web/src/mixed.tsx",
      `import { matchQueryStatus } from "@/lib/match-query-status";
import { SharedErrored } from "@/modules/shared/errored";
import { InvoicesLoading } from "@/modules/invoices/loading";
import { InvoicesSuccess } from "@/modules/invoices/success";
export const Page = ({ query }: { query: never }) =>
  matchQueryStatus(query, {
    renderErrored: <SharedErrored />,
    Loading: <InvoicesLoading />,
    renderSuccess: (result) => <InvoicesSuccess data={result.data} />,
  });
`,
    );

    const result = runOxlint(["apps/web/src/mixed.tsx"]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/query-status-policy\(folder-structure\)/gu)?.length,
      1,
      result.output,
    );
    assert.match(
      result.output,
      /The Loading state is imported from "@\/modules\/invoices" but the renderErrored state is imported from "@\/modules\/shared"/u,
    );
  });

  it("ignores calls to other functions named matchQueryStatus", async () => {
    await writeFixture(
      "apps/web/src/other.tsx",
      `import { matchQueryStatus } from "./local-matcher";
import { InvoicesError } from "@/modules/invoices/error";
export const Page = ({ query }: { query: never }) =>
  matchQueryStatus(query, { renderErrored: <InvoicesError /> });
`,
    );

    const result = runOxlint(["apps/web/src/other.tsx"]);

    assert.equal(result.status, 0, result.output);
  });
});
