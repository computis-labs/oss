import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(import.meta.dirname);
const oxlint = path.join(repositoryRoot, "node_modules", ".bin", "oxlint");
const plugin = fileURLToPath(new URL("no-direct-tag-access.ts", import.meta.url));

describe("effect-tag-policy/no-direct-tag-access", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "no-direct-tag-access-"));
    await writeFile(
      path.join(fixtureRoot, "oxlint.config.ts"),
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  rules: { "effect-tag-policy/no-direct-tag-access": "error" },
};
`,
    );
  });

  afterAll(async () => {
    await rm(fixtureRoot, { force: true, recursive: true });
  });

  const runOxlint = async (source: string) => {
    await writeFile(path.join(fixtureRoot, "fixture.ts"), source);
    const result = spawnSync(
      oxlint,
      ["fixture.ts", "--config", "oxlint.config.ts", "--format", "unix", "--threads", "1"],
      { cwd: fixtureRoot, encoding: "utf-8" },
    );

    return {
      output: `${result.stdout}${result.stderr}`,
      status: result.status ?? 1,
    };
  };

  it("reports direct property access and destructuring", async () => {
    const result = await runOxlint(`
const first = error._tag;
const second = error?.["_tag"];
const third = error[\`_tag\`];
const { _tag: fourth } = error;
`);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/effect-tag-policy\(no-direct-tag-access\)/gu)?.length,
      4,
      result.output,
    );
    assert.match(result.output, /Do not access `_tag` directly/u);
  });

  it("reports interfaces that define tag members", async () => {
    const result = await runOxlint(`
interface IdentifierTag {
  readonly _tag: "Identifier";
}
interface QuotedTag {
  readonly "_tag": "Quoted";
}
interface ComputedTag {
  ["_tag"](): string;
}
`);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/effect-tag-policy\(no-direct-tag-access\)/gu)?.length,
      3,
      result.output,
    );
    assert.match(result.output, /Do not define `_tag` in an interface/u);
  });

  it("allows tagged type aliases, tagged values, and Effect tag utilities", async () => {
    const result = await runOxlint(`
import { Match, Predicate, Result } from "effect";

type Event =
  | { readonly _tag: "Created"; readonly id: string }
  | { readonly _tag: "Removed"; readonly id: string };

const event: Event = { _tag: "Created", id: "123" };
const message = Match.value(event).pipe(
  Match.tag("Created", ({ id }) => id),
  Match.tag("Removed", ({ id }) => id),
  Match.exhaustive,
);
const isCreated = Predicate.isTagged("Created")(event);
const isRight = Result.isSuccess(result);
interface Untagged {
  readonly kind: string;
}
`);

    assert.equal(result.status, 0, result.output);
  });
});
