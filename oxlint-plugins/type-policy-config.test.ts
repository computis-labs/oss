import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "@effect/vitest";

const root = path.dirname(import.meta.dirname);

describe("repository type policy", () => {
  let directory = "";
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "type-policy-config-"));
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
    await mkdir(path.join(directory, "apps/backend/src/services"), { recursive: true });
    await mkdir(path.join(directory, "apps/web/src"), { recursive: true });
    await writeFile(
      path.join(directory, "apps/web/src/external.d.ts"),
      "export declare const read: () => any;",
    );
  });
  afterAll(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  const check = async (file: string, source: string) => {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), source);
    const result = spawnSync(
      path.join(root, "node_modules/.bin/oxlint"),
      [file, "--config", "oxlint.config.ts", "--format", "unix", "--threads", "1"],
      { cwd: directory, encoding: "utf-8" },
    );
    return { output: `${result.stdout}${result.stderr}`, status: result.status };
  };

  it("makes an unsafe assignment a blocking error", async () => {
    const result = await check(
      "apps/web/src/assignment.ts",
      `import { read } from "./external.js";
export const value: string = read();`,
    );
    assert.notEqual(result.status, 0);
    assert.match(result.output, /Error\/typescript\(no-unsafe-assignment\)/u);
  });
});
