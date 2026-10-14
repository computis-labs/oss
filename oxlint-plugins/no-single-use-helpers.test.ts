import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(import.meta.dirname);
const oxlint = path.join(repositoryRoot, "node_modules", ".bin", "oxlint");
const plugin = fileURLToPath(new URL("no-single-use-helpers.ts", import.meta.url));

describe("helper-policy/no-single-use-helpers", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "single-use-helpers-"));
    await writeFile(
      path.join(fixtureRoot, "oxlint.config.ts"),
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  rules: { "helper-policy/no-single-use-helpers": "error" },
};
`,
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

  const runOxlint = (paths: readonly string[], config = "oxlint.config.ts") => {
    const result = spawnSync(
      oxlint,
      [...paths, "--config", config, "--format", "unix", "--threads", "1"],
      { cwd: fixtureRoot, encoding: "utf-8" },
    );

    return {
      output: `${result.stdout}${result.stderr}`,
      status: result.status ?? 1,
    };
  };

  it("reports top-level helpers referenced exactly once", async () => {
    await writeFixture(
      "apps/backend/src/routes/single-use/arrow.test.ts",
      `const updateSettings = (jar, organizationId, body) =>
  Effect.andThen(TestApp, (t) =>
    t.jsonRequest(jar, \`/api/v1/companySettings/\${organizationId}\`, body, "PATCH"),
  );

it.effect("rejects invalid payloads", () =>
  Effect.gen(function* () {
    const response = yield* updateSettings(jar, companyId, {});
    strictEqual(response.status, 400);
  }),
);\n`,
    );
    await writeFixture(
      "apps/backend/src/routes/single-use/declaration.test.ts",
      `function buildConfig(overrides) {
  return { ...defaults, ...overrides };
}

it("uses the config", () => {
  strictEqual(buildConfig({}).APP_ENV, "test");
});\n`,
    );

    const result = runOxlint([
      "apps/backend/src/routes/single-use/arrow.test.ts",
      "apps/backend/src/routes/single-use/declaration.test.ts",
    ]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/helper-policy\(no-single-use-helpers\)/gu)?.length,
      2,
      result.output,
    );
    assert.match(result.output, /Helper 'updateSettings' is only used once/u);
  });

  it("reports single-use helpers wrapped in Effect.fn", async () => {
    await writeFixture(
      "apps/backend/src/modules/effect-fn/traced.ts",
      `const loadRow = Effect.fn("loadRow")(function* (id) {
  return yield* Repository.find(id);
});

export const readRow = Effect.fn("readRow")(function* (id) {
  return yield* loadRow(id);
});\n`,
    );
    await writeFixture(
      "apps/backend/src/modules/effect-fn/untraced.ts",
      `const buildQuery = Effect.fnUntraced(function* (filters) {
  return yield* Query.from(filters);
});

export const runQuery = Effect.fnUntraced(function* (filters) {
  return yield* buildQuery(filters);
});\n`,
    );

    const result = runOxlint([
      "apps/backend/src/modules/effect-fn/traced.ts",
      "apps/backend/src/modules/effect-fn/untraced.ts",
    ]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/helper-policy\(no-single-use-helpers\)/gu)?.length,
      2,
      result.output,
    );
    assert.match(result.output, /Helper 'loadRow' is only used once/u);
    assert.match(result.output, /Helper 'buildQuery' is only used once/u);
  });

  it("allows Effect.fn helpers that more than one call site uses", async () => {
    await writeFixture(
      "apps/backend/src/modules/effect-fn/shared.ts",
      `const loadRow = Effect.fn("loadRow")(function* (id) {
  return yield* Repository.find(id);
});

export const readRow = Effect.fn("readRow")(function* (id) {
  return yield* loadRow(id);
});

export const countRow = Effect.fn("countRow")(function* (id) {
  const row = yield* loadRow(id);
  return row.total;
});\n`,
    );
    await writeFixture(
      "apps/backend/src/modules/effect-fn/not-effect.ts",
      `const handler = Schema.fn("handler")(function* (id) {
  return id;
});

export const run = (id) => handler(id);\n`,
    );

    const result = runOxlint([
      "apps/backend/src/modules/effect-fn/shared.ts",
      "apps/backend/src/modules/effect-fn/not-effect.ts",
    ]);

    assert.equal(result.status, 0, result.output);
  });

  it("reports single-use Effect.fn helpers nested in a service make", async () => {
    await writeFixture(
      "apps/backend/src/modules/nested-effect-fn/service.ts",
      `import { Context, Effect } from "effect";

export class Settings extends Context.Service<Settings>()("Settings", {
  make: Effect.gen(function* settings() {
    const repository = yield* Repository;

    const findCompany = Effect.fn("Settings.findCompany")(function* findCompanyProgram(id) {
      return yield* repository.find(id);
    });

    const getSettings = Effect.fn("Settings.getSettings")(function* getSettingsProgram(id) {
      return yield* findCompany(id);
    });

    return { getSettings };
  }),
}) {}\n`,
    );
    await writeFixture(
      "apps/backend/src/modules/nested-effect-fn/shadow.ts",
      `import { Effect } from "effect";

const load = Effect.fn("load")(function* loadProgram(id) {
  return yield* Repository.find(id);
});

export const first = Effect.fn("first")(function* firstProgram(id) {
  return yield* load(id);
});

export const second = Effect.gen(function* secondProgram() {
  const load = Effect.fn("inner")(function* innerProgram(id) {
    return yield* Cache.get(id);
  });

  return yield* load("a");
});\n`,
    );

    const result = runOxlint([
      "apps/backend/src/modules/nested-effect-fn/service.ts",
      "apps/backend/src/modules/nested-effect-fn/shadow.ts",
    ]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/helper-policy\(no-single-use-helpers\)/gu)?.length,
      3,
      result.output,
    );
    assert.match(result.output, /Helper 'findCompany' is only used once/u);
    assert.match(result.output, /shadow\.ts:3:7: Helper 'load' is only used once/u);
    assert.match(result.output, /shadow\.ts:12:9: Helper 'load' is only used once/u);
    assert.doesNotMatch(result.output, /Helper 'getSettings'/u);
  });

  it("allows nested Effect.fn helpers that are exposed or shared", async () => {
    await writeFixture(
      "apps/backend/src/modules/nested-effect-fn/exposed.ts",
      `import { Context, Effect } from "effect";

export class Settings extends Context.Service<Settings>()("Settings", {
  make: Effect.gen(function* settings() {
    const repository = yield* Repository;

    const findCompany = Effect.fn("Settings.findCompany")(function* findCompanyProgram(id) {
      return yield* repository.find(id);
    });

    const getSettings = Effect.fn("Settings.getSettings")(function* getSettingsProgram(id) {
      return yield* findCompany(id);
    });

    const updateSettings = Effect.fn("Settings.updateSettings")(
      function* updateSettingsProgram(id, payload) {
        const company = yield* findCompany(id);
        return yield* repository.update(company, payload);
      },
    );

    const readAll = Effect.fn("Settings.readAll")(function* readAllProgram() {
      return yield* repository.all();
    });

    return { getSettings, list: readAll, updateSettings };
  }),
}) {}\n`,
    );
    await writeFixture(
      "apps/backend/src/modules/nested-effect-fn/arrow.ts",
      `import { Effect } from "effect";

export const make = Effect.sync(() => {
  const read = Effect.fn("read")(function* readProgram(id) {
    return yield* Store.get(id);
  });

  return { read };
});

export const plain = Effect.gen(function* plainProgram() {
  const step = (id) => Store.get(id);

  return yield* step("a");
});\n`,
    );

    const result = runOxlint([
      "apps/backend/src/modules/nested-effect-fn/exposed.ts",
      "apps/backend/src/modules/nested-effect-fn/arrow.ts",
    ]);

    assert.equal(result.status, 0, result.output);
  });

  it("allows shared helpers, non-function constants, and unused names", async () => {
    await writeFixture(
      "apps/backend/src/routes/shared/shared.test.ts",
      `const validPayload = (overrides = {}) => ({ name: "Alfa", ...overrides });

it("first", () => {
  deepStrictEqual(validPayload().name, "Alfa");
});
it("second", () => {
  deepStrictEqual(validPayload({ name: "Beta" }).name, "Beta");
});\n`,
    );
    await writeFixture(
      "apps/backend/src/routes/shared/non-function.test.ts",
      `const suiteLayer = testAppLayer({ session: { email: "a@b.c", name: "A" } });

it.layer(suiteLayer)("suite", (it) => {
  it.effect("works", () => Effect.void);
});\n`,
    );
    await writeFixture(
      "apps/backend/src/routes/shared/shadowed.test.ts",
      `const decode = (input) => Schema.decodeUnknownSync(Item)(input);

it("first", () => {
  strictEqual(decode("a").tag, "a");
});
it("second", () => {
  strictEqual([1].map((decode) => decode).length, 1);
});\n`,
    );

    const result = runOxlint([
      "apps/backend/src/routes/shared/shared.test.ts",
      "apps/backend/src/routes/shared/non-function.test.ts",
      "apps/backend/src/routes/shared/shadowed.test.ts",
    ]);

    assert.equal(result.status, 0, result.output);
  });

  it("does not count an interface member named like a helper as a use", async () => {
    await writeFixture(
      "packages/runner/src/runner.ts",
      `export interface RunnerApi {
  readonly getInput: (name: string) => string;
}

export const getInput = (name: string) => name.trim();\n`,
    );

    const result = runOxlint(["packages/runner/src/runner.ts"]);

    assert.equal(result.status, 0, result.output);
  });

  it("does not count the name of a function expression as a use", async () => {
    await writeFixture(
      "packages/runner/src/named-generator.ts",
      `const make = () => ({
  decode: Effect.fn("Client.decode")(function* decode(input: string) {
    yield* Effect.void;
    return input;
  }),
});

export const client = make();
export const otherClient = make();

export const decode = (input: string) => input.trim();\n`,
    );

    const result = runOxlint(["packages/runner/src/named-generator.ts"]);

    assert.equal(result.status, 0, result.output);
  });

  it("reports object and array constants used once, through as const and satisfies", async () => {
    await writeFixture(
      "apps/backend/src/modules/drive/repository.ts",
      `const fileColumns = { contentType: true, id: true } as const;
const sweepMeta = { system: "invoice payments sweep" } satisfies QueryMeta;
const roles = ["owner", "admin"];

export const listFiles = () => db.file.findMany({ select: fileColumns });
export const sweep = () => db.invoice.updateMany({ meta: sweepMeta });
export const isAdmin = (role) => roles.includes(role);\n`,
    );

    const result = runOxlint(["apps/backend/src/modules/drive/repository.ts"]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/Constant '(?:fileColumns|sweepMeta|roles)' is only used once/gu)?.length,
      3,
      result.output,
    );
  });

  it("allows shared, exported-and-imported, scalar, computed, empty, repeatedly evaluated, and switched-off constants", async () => {
    await writeFixture(
      "apps/backend/src/modules/drive/shared-constants.ts",
      `const fileColumns = { id: true } as const;
const MESSAGE = "Cartella non trovata.";
const FOLDER_NAME = /^[a-z]+$/u;

export const listFiles = () => db.file.findMany({ select: fileColumns });
export const findFile = () => db.file.findFirst({ select: fileColumns });
export const notFound = () => new Error(MESSAGE);
export const valid = (name) => FOLDER_NAME.test(name);\n`,
    );
    await writeFixture(
      "apps/backend/src/modules/drive/columns.ts",
      `export const driveColumns = { id: true } as const;\nexport const read = () => db.file.findMany({ select: driveColumns });\n`,
    );
    await writeFixture(
      "apps/backend/src/modules/drive/reader.ts",
      `import { driveColumns } from "./columns";\nexport const columns = driveColumns;\n`,
    );
    await writeFixture(
      "constants-off.config.ts",
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  rules: { "helper-policy/no-single-use-helpers": ["error", { checkConstants: false }] },
};
`,
    );
    await writeFixture(
      "apps/backend/src/modules/drive/fixture.ts",
      `const payload = { name: "Alfa" };\nexport const build = () => ({ ...payload });\n`,
    );
    await writeFixture(
      "apps/backend/src/modules/drive/hoisted.tsx",
      `const FORMATTERS = { it: new Intl.DateTimeFormat("it") };
const NO_ROWS: readonly string[] = [];
const PATTERN = { flags: String.raw\`u\` };
const CHANNELS = { red: toChannel("r") };
const ENTITIES = [["lt", 60]];
const DIGITS = [1, 2, 3];
const WEIGHTS = { a: 1 };
const NEVER = { current: false };
const KINDS = ["a", "b"] as const;
export type Kind = (typeof KINDS)[number];
const META: Meta = { action: "primary" };
export const submit = () => send(META);

export const format = (date) => FORMATTERS.it.format(date);
export const Rows = ({ rows }) => <List rows={rows ?? NO_ROWS} />;
export const flags = () => PATTERN.flags;
export const red = () => CHANNELS.red;
export const entity = (name) => {
  for (const [key, code] of ENTITIES) {
    if (key === name) return code;
  }
};
export const precise = (values) => values.map((value) => DIGITS.find((digit) => digit === value));
export const weigh = (chars) => Array.from(chars, (char) => WEIGHTS[char]);
export const useReveal = (revealed = NEVER) => revealed.current;\n`,
    );

    const shared = runOxlint([
      "apps/backend/src/modules/drive/shared-constants.ts",
      "apps/backend/src/modules/drive/columns.ts",
      "apps/backend/src/modules/drive/reader.ts",
      "apps/backend/src/modules/drive/hoisted.tsx",
    ]);
    const switchedOff = runOxlint(
      ["apps/backend/src/modules/drive/fixture.ts"],
      "constants-off.config.ts",
    );

    assert.equal(shared.status, 0, shared.output);
    assert.equal(switchedOff.status, 0, switchedOff.output);
  });

  it("reports single-use interfaces that export alone tries to excuse", async () => {
    await writeFixture(
      "apps/backend/src/modules/interfaces/local.ts",
      `interface Row {
  readonly id: string;
}

export const read = (row: Row) => row.id;\n`,
    );
    await writeFixture(
      "apps/backend/src/modules/interfaces/exported.ts",
      `export interface Options {
  readonly retries: number;
}

export const run = (options: Options) => options.retries;\n`,
    );

    const result = runOxlint([
      "apps/backend/src/modules/interfaces/local.ts",
      "apps/backend/src/modules/interfaces/exported.ts",
    ]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/helper-policy\(no-single-use-helpers\)/gu)?.length,
      2,
      result.output,
    );
    assert.match(result.output, /Interface 'Options' is only used once and no other file/u);
  });

  it("reports single-use type aliases", async () => {
    await writeFixture(
      "apps/backend/src/modules/type-aliases/local.ts",
      `type EncodedVehicle =
  | { readonly Data: string; readonly TotalePercorso: string }
  | undefined;

export const encodedVehicle = (enabled: boolean): EncodedVehicle =>
  enabled ? { Data: "2026-08-30", TotalePercorso: "100" } : undefined;\n`,
    );

    const result = runOxlint(["apps/backend/src/modules/type-aliases/local.ts"]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/helper-policy\(no-single-use-helpers\)/gu)?.length,
      1,
      result.output,
    );
    assert.match(result.output, /Type alias 'EncodedVehicle' is only used once/u);
  });

  it("can check types without reporting function helpers", async () => {
    await writeFixture(
      "types-only.config.ts",
      `export default {
  jsPlugins: [${JSON.stringify(plugin)}],
  rules: { "helper-policy/no-single-use-helpers": ["error", { checkFunctions: false }] },
};
`,
    );
    await writeFixture(
      "apps/backend/src/modules/type-aliases/types-only.ts",
      `type EncodedVehicle = { readonly Data: string } | undefined;

const encode = (enabled: boolean) => enabled ? { Data: "2026-08-30" } : undefined;

export const encodedVehicle = (enabled: boolean): EncodedVehicle => encode(enabled);\n`,
    );

    const result = runOxlint(
      ["apps/backend/src/modules/type-aliases/types-only.ts"],
      "types-only.config.ts",
    );

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/helper-policy\(no-single-use-helpers\)/gu)?.length,
      1,
      result.output,
    );
    assert.match(result.output, /Type alias 'EncodedVehicle' is only used once/u);
    assert.doesNotMatch(result.output, /Helper 'encode'/u);
  });

  it("allows type declarations that another file imports or that carry a contract", async () => {
    await writeFixture(
      "apps/backend/src/modules/shared-interfaces/model.ts",
      `export interface Account {
  readonly iban: string;
}

export const label = (account: Account) => account.iban;\n`,
    );
    await writeFixture(
      "apps/backend/src/modules/shared-interfaces/consumer.ts",
      `import type { Account } from "./model.ts";

export const mask = (account: Account) => account.iban.slice(-4);\n`,
    );
    await writeFixture(
      "apps/backend/src/modules/shared-interfaces/alias.ts",
      `export type AccountId = string;

export const normalize = (id: AccountId) => id.trim();\n`,
    );
    await writeFixture(
      "apps/backend/src/modules/shared-interfaces/alias-consumer.ts",
      `import type { AccountId } from "./alias.ts";

export const prefix = (id: AccountId) => \`account-\${id}\`;\n`,
    );
    await writeFixture(
      "apps/backend/src/modules/shared-interfaces/contract.ts",
      `interface Runner {
  run(): void;
}

export class Job implements Runner {
  run() {
    return undefined;
  }
}\n`,
    );
    await writeFixture(
      "apps/backend/src/modules/shared-interfaces/shared.ts",
      `interface Point {
  readonly x: number;
}

export const start = (point: Point) => point.x;
export const end = (point: Point) => point.x + 1;\n`,
    );

    const result = runOxlint([
      "apps/backend/src/modules/shared-interfaces/model.ts",
      "apps/backend/src/modules/shared-interfaces/consumer.ts",
      "apps/backend/src/modules/shared-interfaces/alias.ts",
      "apps/backend/src/modules/shared-interfaces/alias-consumer.ts",
      "apps/backend/src/modules/shared-interfaces/contract.ts",
      "apps/backend/src/modules/shared-interfaces/shared.ts",
    ]);

    assert.equal(result.status, 0, result.output);
  });

  it("allows a port surface and the vocabulary reachable from it", async () => {
    await writeFixture(
      "apps/backend/src/modules/ports/provider.ts",
      `import { Context, Effect } from "effect";

export interface AppointeeProfile {
  readonly email: string;
}

export interface ProviderApi {
  readonly createAppointee: (profile: AppointeeProfile) => void;
}

export class Provider extends Context.Tag("Provider")<Provider, ProviderApi>() {}\n`,
    );
    await writeFixture(
      "apps/backend/src/modules/ports/catalog.ts",
      `import { Effect } from "effect";

export interface FontEntry {
  readonly family: string;
}

export interface CatalogApi {
  readonly list: () => readonly FontEntry[];
}

export class Catalog extends Effect.Service<Catalog>()("Catalog", {
  effect: Effect.sync(() => ({ list: () => [] }) satisfies CatalogApi),
}) {}\n`,
    );

    const result = runOxlint([
      "apps/backend/src/modules/ports/provider.ts",
      "apps/backend/src/modules/ports/catalog.ts",
    ]);

    assert.equal(result.status, 0, result.output);
  });

  it("allows a type nested in an interface that another file imports", async () => {
    await writeFixture(
      "apps/backend/src/modules/nested/rates.ts",
      `export interface StoredRate {
  readonly isoCode: string;
}

export interface StoredSnapshot {
  readonly rates: readonly StoredRate[];
}

export const empty = (snapshot: StoredSnapshot) => snapshot.rates.length;\n`,
    );
    await writeFixture(
      "apps/backend/src/modules/nested/consumer.ts",
      `import type { StoredSnapshot } from "./rates.ts";

export const count = (snapshot: StoredSnapshot) => snapshot.rates.length;\n`,
    );

    const result = runOxlint([
      "apps/backend/src/modules/nested/rates.ts",
      "apps/backend/src/modules/nested/consumer.ts",
    ]);

    assert.equal(result.status, 0, result.output);
  });

  it("reports exported helpers that no other file imports", async () => {
    await writeFixture(
      "apps/backend/src/modules/exported-helpers/orphan.ts",
      `export const normalize = (value: string) => value.trim();

export const read = (value: string) => normalize(value).length;\n`,
    );
    await writeFixture(
      "apps/backend/src/modules/exported-helpers/used.ts",
      `const format = (value: string) => value.toUpperCase();

export { format };

export const title = (value: string) => format(value);\n`,
    );
    await writeFixture(
      "apps/backend/src/modules/exported-helpers/importer.ts",
      `import { format } from "./used.ts";

export const shout = (value: string) => \`\${format(value)}!\`;\n`,
    );

    const result = runOxlint([
      "apps/backend/src/modules/exported-helpers/orphan.ts",
      "apps/backend/src/modules/exported-helpers/used.ts",
      "apps/backend/src/modules/exported-helpers/importer.ts",
    ]);

    assert.equal(result.status, 1);
    assert.equal(
      result.output.match(/helper-policy\(no-single-use-helpers\)/gu)?.length,
      1,
      result.output,
    );
    assert.match(result.output, /Helper 'normalize' is only used once/u);
  });

  it("allows helpers that cannot be inlined", async () => {
    await writeFixture(
      "apps/backend/src/routes/uninlinable/recursive.test.ts",
      `const countDown = (n) => (n <= 0 ? 0 : countDown(n - 1));

it("terminates", () => {
  strictEqual(countDown(3), 0);
});\n`,
    );
    await writeFixture(
      "apps/backend/src/routes/uninlinable/type-predicate.ts",
      `interface Shape { readonly kind: string }

export const emptyShape: Shape = { kind: "" };

const isShape = (value: unknown): value is Shape =>
  typeof value === "object" && value !== null && "kind" in value;

function isKind(value: unknown): value is string {
  return typeof value === "string";
}

export const read = (value: unknown) => {
  if (!isShape(value)) {
    return "";
  }
  return isKind(value.kind) ? value.kind : "";
};\n`,
    );
    await writeFixture(
      "apps/backend/src/routes/uninlinable/type-reference.ts",
      `const splitRefs = (xs: readonly string[]) => xs.map((x) => x.trim());

const consume = (refs: ReturnType<typeof splitRefs>, extra: string) => [...refs, extra];

export const first = () => consume(splitRefs(["a"]), "b");
export const second = () => consume([], "c");\n`,
    );

    const result = runOxlint([
      "apps/backend/src/routes/uninlinable/recursive.test.ts",
      "apps/backend/src/routes/uninlinable/type-predicate.ts",
      "apps/backend/src/routes/uninlinable/type-reference.ts",
    ]);

    assert.equal(result.status, 0, result.output);
  });
});
