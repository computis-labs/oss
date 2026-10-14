import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(import.meta.dirname);
const oxlint = path.join(repositoryRoot, "node_modules", ".bin", "oxlint");
const plugin = fileURLToPath(new URL("no-use-effect.ts", import.meta.url));

describe("react-hooks-policy/no-direct-use-effect", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "no-use-effect-"));
    await writeFile(
      path.join(fixtureRoot, "oxlint.config.ts"),
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  overrides: [{
    files: ["apps/web/**/*.{ts,tsx}"],
    rules: { "react-hooks-policy/no-direct-use-effect": "error" },
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

  it("reports useEffect in components and custom hooks", async () => {
    await writeFixture(
      "apps/web/src/component.tsx",
      `import { useEffect } from "react";
export const Box = () => {
  useEffect(() => {}, []);
  return null;
};
`,
    );
    await writeFixture(
      "apps/web/src/use-document-exchange-rate.ts",
      `import { useEffect } from "react";
export const useDocumentExchangeRate = () => {
  useEffect(() => {}, []);
};
`,
    );
    await writeFixture(
      "apps/web/src/namespace.tsx",
      `import * as React from "react";
export const useSyncThing = () => {
  React.useEffect(() => {}, []);
};
`,
    );
    await writeFixture(
      "apps/web/src/aliased.ts",
      `import { useEffect as useLayoutSideEffect } from "react";
export const useAliased = () => {
  useLayoutSideEffect(() => {}, []);
};
`,
    );

    const result = runOxlint([
      "apps/web/src/component.tsx",
      "apps/web/src/use-document-exchange-rate.ts",
      "apps/web/src/namespace.tsx",
      "apps/web/src/aliased.ts",
    ]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/react-hooks-policy\(no-direct-use-effect\)/gu)?.length,
      4,
      result.output,
    );
    assert.match(result.output, /Do not call useEffect/u);
  });

  it("allows useEffect only inside the sanctioned helper", async () => {
    await writeFixture(
      "apps/web/src/use-mount-effect.ts",
      `import { useEffect } from "react";
export const useMountEffect = (effect) => {
  useEffect(() => effect(), []);
};
`,
    );
    await writeFixture(
      "apps/web/src/use-mount-effect-declared.ts",
      `import { useEffect } from "react";
export function useMountEffect(effect) {
  useEffect(() => effect(), []);
}
`,
    );
    await writeFixture(
      "apps/web/src/use-mount-effect-lookalike.ts",
      `import { useEffect } from "react";
export const useMountEffectOnce = (effect) => {
  useEffect(() => effect(), []);
};
`,
    );

    const result = runOxlint([
      "apps/web/src/use-mount-effect.ts",
      "apps/web/src/use-mount-effect-declared.ts",
      "apps/web/src/use-mount-effect-lookalike.ts",
    ]);

    assert.equal(
      result.output.match(/react-hooks-policy\(no-direct-use-effect\)/gu)?.length,
      1,
      result.output,
    );
    assert.match(result.output, /use-mount-effect-lookalike/u);
  });

  it("allows non-effect react hooks", async () => {
    await writeFixture(
      "apps/web/src/ok.ts",
      `import { useMemo, useState } from "react";
export const useValues = () => {
  const [value, setValue] = useState(0);
  return useMemo(() => value + 1, [value]);
};
`,
    );

    const result = runOxlint(["apps/web/src/ok.ts"]);

    assert.equal(result.status, 0, result.output);
    assert.doesNotMatch(result.output, /react-hooks-policy\(no-direct-use-effect\)/u);
  });
});
