import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "@effect/vitest";

const root = path.dirname(import.meta.dirname);
const restrictedImport = /eslint\(no-restricted-imports\)/gu;

describe("lib/api boundary of the web apps", () => {
  let directory = "";
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "query-boundary-config-"));
    await symlink(path.join(root, "node_modules"), path.join(directory, "node_modules"), "dir");
    await symlink(path.join(root, "oxlint-plugins"), path.join(directory, "oxlint-plugins"), "dir");
    await writeFile(
      path.join(directory, "oxlint.config.ts"),
      `export { default } from ${JSON.stringify(path.join(root, "oxlint.config.ts"))};`,
    );
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(
      path.join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          target: "ESNext",
        },
        include: ["apps/**/*.ts"],
      }),
    );
  });
  afterAll(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  const restrictedImports = async (file: string, source: string) => {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), source);
    const result = spawnSync(
      path.join(root, "node_modules/.bin/oxlint"),
      [file, "--config", "oxlint.config.ts", "--format", "unix", "--threads", "1"],
      { cwd: directory, encoding: "utf-8" },
    );
    return `${result.stdout}${result.stderr}`.match(restrictedImport)?.length ?? 0;
  };

  it("flags the query client and keepPreviousData in a web module", async () => {
    const count = await restrictedImports(
      "apps/web/src/modules/client.ts",
      `import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
export const client = { keepPreviousData, useQueryClient };`,
    );
    assert.equal(count, 2);
  });

  it("flags a query hook in a web route", async () => {
    const count = await restrictedImports(
      "apps/web/src/routes/query.ts",
      `import { useQuery } from "@tanstack/react-query";
export const query = useQuery;`,
    );
    assert.equal(count, 1);
  });

  it("flags useAppMutation imported outside lib", async () => {
    const count = await restrictedImports(
      "apps/web/src/modules/mutation.ts",
      `import { useAppMutation } from "@/lib/use-app-mutation";
export const mutation = useAppMutation;`,
    );
    assert.equal(count, 1);
  });

  it("flags useMutation in a lib file other than use-app-mutation", async () => {
    const count = await restrictedImports(
      "apps/web/src/lib/api/drive/mutation.ts",
      `import { useMutation } from "@tanstack/react-query";
export const mutation = useMutation;`,
    );
    assert.equal(count, 1);
  });

  it("flags a query hook in a dealflow module", async () => {
    const count = await restrictedImports(
      "apps/dealflow/src/modules/query.ts",
      `import { useQuery } from "@tanstack/react-query";
export const query = useQuery;`,
    );
    assert.equal(count, 1);
  });

  it("allows the query client, keepPreviousData and useAppMutation in lib/api", async () => {
    const count = await restrictedImports(
      "apps/web/src/lib/api/drive/cache.ts",
      `import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppMutation } from "@/lib/use-app-mutation";
export const cache = { keepPreviousData, useAppMutation, useQuery, useQueryClient };`,
    );
    assert.equal(count, 0);
  });

  it("allows useMutation in use-app-mutation", async () => {
    const webCount = await restrictedImports(
      "apps/web/src/lib/use-app-mutation.ts",
      `import { useMutation } from "@tanstack/react-query";
export const useAppMutation = useMutation;`,
    );
    const dealflowCount = await restrictedImports(
      "apps/dealflow/src/lib/use-app-mutation.ts",
      `import { useMutation } from "@tanstack/react-query";
export const useAppMutation = useMutation;`,
    );
    assert.equal(webCount + dealflowCount, 0);
  });

  it("allows the query client provider in a web module", async () => {
    const count = await restrictedImports(
      "apps/web/src/modules/providers.ts",
      `import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
export const providers = { QueryClient, QueryClientProvider };`,
    );
    assert.equal(count, 0);
  });
});
