import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(import.meta.dirname);
const oxlint = path.join(repositoryRoot, "node_modules", ".bin", "oxlint");
const plugin = fileURLToPath(
  new URL("no-inline-match-query-status-components.ts", import.meta.url),
);

const hooks = `import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";

export const useItems = () =>
  useQuery({ queryFn: async () => ["a"], queryKey: ["items"] });

export const useItem = () =>
  useSuspenseQuery({ queryFn: async () => "a", queryKey: ["item"] });

export const usePages = () =>
  useInfiniteQuery({
    getNextPageParam: () => undefined,
    initialPageParam: 0,
    queryFn: async () => ["a"],
    queryKey: ["pages"],
  });

export const useSave = () => useMutation({ mutationFn: async () => 1 });
`;

describe("query-status-policy/prefer-match-query-status", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "prefer-match-query-status-"));
    await symlink(
      path.join(repositoryRoot, "apps", "web", "node_modules"),
      path.join(fixtureRoot, "node_modules"),
      "dir",
    );
    await writeFile(
      path.join(fixtureRoot, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          jsx: "react-jsx",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          target: "ESNext",
        },
        include: ["src/**/*.ts", "src/**/*.tsx"],
      }),
    );
    await writeFile(
      path.join(fixtureRoot, "oxlint.config.ts"),
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  rules: { "query-status-policy/prefer-match-query-status": "error" },
};
`,
    );
    await writeFixture("src/hooks.ts", hooks);
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

  const reports = (output: string) =>
    output.match(/query-status-policy\(prefer-match-query-status\)/gu)?.length ?? 0;

  it("reports a flag that picks the JSX of a conditional", async () => {
    await writeFixture(
      "src/conditional.tsx",
      `import { useItems } from "./hooks";

export const Items = () => {
  const query = useItems();
  return query.isError ? <p>failed</p> : <p>loading</p>;
};
`,
    );

    const result = runOxlint(["src/conditional.tsx"]);

    assert.equal(result.status, 1);
    assert.equal(reports(result.output), 1, result.output);
    assert.match(result.output, /Do not branch on `isError` to pick what the component renders/u);
  });

  it("allows a conditional on the flag that yields text for a prop", async () => {
    await writeFixture(
      "src/conditional-text.tsx",
      `import { useItems } from "./hooks";

const Title = ({ text }: { readonly text: string }) => <h1>{text}</h1>;

export const Items = () => {
  const query = useItems();
  return <Title text={query.isPending ? "Loading" : "Items"} />;
};
`,
    );

    const result = runOxlint(["src/conditional-text.tsx"]);

    assert.equal(result.status, 0, result.output);
  });

  it("reports an if on the flag that returns from a component", async () => {
    await writeFixture(
      "src/if.tsx",
      `import { useItems } from "./hooks";

export const Items = () => {
  const query = useItems();
  if (query.isPending) {
    return null;
  }
  if (!query.isSuccess) {
    return <p>failed</p>;
  }
  return <p>{query.data.length}</p>;
};
`,
    );

    const result = runOxlint(["src/if.tsx"]);

    assert.equal(result.status, 1);
    assert.equal(reports(result.output), 2, result.output);
  });

  it("allows an if on the flag in a helper that returns no JSX", async () => {
    await writeFixture(
      "src/if-helper.tsx",
      `import { useItems } from "./hooks";

const countOf = (query: ReturnType<typeof useItems>) => {
  if (query.isError) {
    return undefined;
  }
  return query.data?.length;
};

export const Items = () => <p>{countOf(useItems())}</p>;
`,
    );

    const result = runOxlint(["src/if-helper.tsx"]);

    assert.equal(result.status, 0, result.output);
  });

  it("reports && and || on the flag that yield JSX", async () => {
    await writeFixture(
      "src/logical.tsx",
      `import { useItems } from "./hooks";

export const Items = ({ ready }: { readonly ready: boolean }) => {
  const query = useItems();
  return (
    <div>
      {query.isLoading && <p>loading</p>}
      {(ready && query.isSuccess) || <p>waiting</p>}
    </div>
  );
};
`,
    );

    const result = runOxlint(["src/logical.tsx"]);

    assert.equal(result.status, 1);
    assert.equal(reports(result.output), 2, result.output);
  });

  it("allows && and || on the flag that yield a value", async () => {
    await writeFixture(
      "src/logical-value.tsx",
      `import { useItems } from "./hooks";

export const Items = ({ ready }: { readonly ready: boolean }) => {
  const query = useItems();
  const empty = query.isSuccess && query.data.length === 0;
  return <input disabled={!ready || query.isPending} readOnly={empty} />;
};
`,
    );

    const result = runOxlint(["src/logical-value.tsx"]);

    assert.equal(result.status, 0, result.output);
  });

  it("reports a flag stored in a constant that a branch then reads", async () => {
    await writeFixture(
      "src/constant.tsx",
      `import { useItems } from "./hooks";

export const Items = () => {
  const query = useItems();
  const loading = query.isPending;
  return loading ? <p>loading</p> : <p>{query.data.length}</p>;
};
`,
    );

    const result = runOxlint(["src/constant.tsx"]);

    assert.equal(result.status, 1);
    assert.equal(reports(result.output), 1, result.output);
  });

  it("allows a flag stored in a constant that only feeds an object", async () => {
    await writeFixture(
      "src/constant-object.tsx",
      `import { useItems } from "./hooks";

export const useStatus = () => {
  const query = useItems();
  const isPending = query.isPending;
  return { isPending };
};
`,
    );

    const result = runOxlint(["src/constant-object.tsx"]);

    assert.equal(result.status, 0, result.output);
  });

  it("reports the flags of suspense and infinite queries", async () => {
    await writeFixture(
      "src/kinds.tsx",
      `import { useItem, usePages } from "./hooks";

export const Item = () => {
  const item = useItem();
  const pages = usePages();
  return (
    <div>
      {item.isSuccess ? <p>{item.data}</p> : null}
      {pages.isError ? <p>failed</p> : null}
    </div>
  );
};
`,
    );

    const result = runOxlint(["src/kinds.tsx"]);

    assert.equal(result.status, 1);
    assert.equal(reports(result.output), 2, result.output);
  });

  it("allows a flag passed as a prop, a mutation flag, and a flag of another object", async () => {
    await writeFixture(
      "src/allowed.tsx",
      `import { useItems, useSave } from "./hooks";

const Button = ({ loading }: { readonly loading: boolean }) => <button disabled={loading} />;

interface Session {
  readonly isPending: boolean;
}

export const Items = ({ session }: { readonly session: Session }) => {
  const query = useItems();
  const save = useSave();
  if (session.isPending) {
    return null;
  }
  return (
    <div>
      <Button loading={query.isPending} />
      {save.isPending ? <p>saving</p> : <p>saved</p>}
    </div>
  );
};
`,
    );

    const result = runOxlint(["src/allowed.tsx"]);

    assert.equal(result.status, 0, result.output);
  });

  it("reports a prop that branches on the flag to pick JSX", async () => {
    await writeFixture(
      "src/prop-jsx.tsx",
      `import { useItems } from "./hooks";

const Card = ({ body }: { readonly body: React.ReactNode }) => <div>{body}</div>;

export const Items = () => {
  const query = useItems();
  return <Card body={query.isPending ? <p>loading</p> : <p>ready</p>} />;
};
`,
    );

    const result = runOxlint(["src/prop-jsx.tsx"]);

    assert.equal(result.status, 1);
    assert.equal(reports(result.output), 1, result.output);
  });
});
