import { describe, expect, it } from "@effect/vitest";
import {
  Config,
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Stream,
} from "effect";
import * as Dataset from "../src/dataset.ts";

interface Movement {
  readonly id: string;
  readonly description: string;
  readonly group: string;
}

const MovementSchema = Schema.Struct({
  description: Schema.String,
  group: Schema.String,
  id: Schema.String,
});

const identify = {
  id: (movement: Movement) => movement.id,
  tags: (movement: Movement) => [`group:${movement.group}`],
};

const files = (contents: ReadonlyMap<string, string>) => {
  const missing = FileSystem.makeNoop({});
  return Layer.merge(
    FileSystem.layerNoop({
      readDirectory: (folder) =>
        Effect.succeed(
          [...contents.keys()]
            .filter((file) => file.startsWith(`${folder}/`))
            .map((file) => file.slice(folder.length + 1)),
        ),
      readFileString: (file) =>
        Option.match(Option.fromNullishOr(contents.get(file)), {
          onNone: () => missing.readFileString(file),
          onSome: Effect.succeed,
        }),
    }),
    Path.layer,
  );
};

const idsOf = <A>(loaded: Dataset.Loaded<A>) => loaded.cases.map((entry) => entry.id);

const movements: readonly Movement[] = [
  { description: "AFFITTO", group: "rent", id: "m1" },
  { description: "ENI", group: "fuel", id: "m2" },
  { description: "Q8", group: "fuel", id: "m3" },
  { description: "IP", group: "fuel", id: "m4" },
  { description: "AFFITTO BOX", group: "rent", id: "m5" },
  { description: "TAMOIL", group: "fuel", id: "m6" },
];

describe("Dataset.fromIterable", () => {
  it.effect("loads the cases with their tags and keeps the skips apart", () =>
    Effect.gen(function* () {
      const loaded = yield* Dataset.load(
        Dataset.fromIterable(
          [
            { description: "AFFITTO", group: "rent", id: "m1" },
            Dataset.skip("p7", "no golden XML"),
          ],
          identify,
        ),
      );

      expect(loaded.cases).toEqual([
        {
          id: "m1",
          input: { description: "AFFITTO", group: "rent", id: "m1" },
          tags: ["group:rent"],
        },
      ]);
      expect(loaded.skipped).toMatchObject([{ id: "p7", reason: "no golden XML" }]);
    }),
  );

  it.effect("fails when two entries share an id", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        Dataset.load(
          Dataset.fromIterable(
            [
              { description: "ENI", group: "fuel", id: "m2" },
              { description: "Q8", group: "fuel", id: "m2" },
            ],
            identify,
          ),
        ),
      );

      expect(failure.message).toBe("Two cases have the id m2.");
    }),
  );
});

describe("Dataset.fromEffect, Dataset.stream and Dataset.concat", () => {
  it.effect("joins the entries of two datasets in order", () =>
    Effect.gen(function* () {
      const first = Dataset.fromEffect(Effect.succeed(movements.slice(0, 2)), identify);
      const second = Dataset.stream(Stream.fromIterable(movements.slice(2, 3)), identify);

      const loaded = yield* Dataset.load(Dataset.concat(second)(first));

      expect(idsOf(loaded)).toEqual(["m1", "m2", "m3"]);
    }),
  );
});

describe("Dataset.filter", () => {
  const dataset = Dataset.fromIterable([...movements, Dataset.skip("m9", "not paired")], identify);

  it.effect("keeps only the cases and the skips with the given ids", () =>
    Effect.gen(function* () {
      const loaded = yield* Dataset.load(Dataset.filter({ ids: ["m2", "m5", "m9"] })(dataset));

      expect(idsOf(loaded)).toEqual(["m2", "m5"]);
      expect(loaded.skipped.map((skipped) => skipped.id)).toEqual(["m9"]);
    }),
  );

  it.effect("drops the untagged skips when it selects by tag", () =>
    Effect.gen(function* () {
      const loaded = yield* Dataset.load(Dataset.filter({ tags: ["group:rent"] })(dataset));

      expect(loaded.skipped).toEqual([]);
    }),
  );

  it.effect("keeps the skips of the selected month and drops those of another", () =>
    Effect.gen(function* () {
      const pages = Dataset.fromIterable(
        [
          { month: "gennaio", page: "gennaio-01.pdf" },
          Dataset.skip("gennaio-02.pdf", "no golden XML", { tags: ["month:gennaio"] }),
          { month: "febbraio", page: "febbraio-01.pdf" },
          Dataset.skip("febbraio-02.pdf", "no golden XML", { tags: ["month:febbraio"] }),
        ],
        { id: (input) => input.page, tags: (input) => [`month:${input.month}`] },
      );

      const loaded = yield* Dataset.load(Dataset.filter({ tags: ["month:gennaio"] })(pages));

      expect([idsOf(loaded), loaded.skipped.map((skipped) => skipped.id)]).toEqual([
        ["gennaio-01.pdf"],
        ["gennaio-02.pdf"],
      ]);
    }),
  );

  it.effect("keeps the cases that carry any of the tags", () =>
    Effect.gen(function* () {
      const loaded = yield* Dataset.load(Dataset.filter({ tags: ["group:rent"] })(dataset));

      expect(idsOf(loaded)).toEqual(["m1", "m5"]);
    }),
  );

  it.effect("keeps the first cases up to the limit", () =>
    Effect.gen(function* () {
      const loaded = yield* Dataset.load(
        Dataset.filter({ limit: 2, tags: ["group:fuel"] })(dataset),
      );

      expect(idsOf(loaded)).toEqual(["m2", "m3"]);
    }),
  );

  it.effect("counts skips in the limit, in order, as the golden set limits its pages", () =>
    Effect.gen(function* () {
      const pages = Dataset.fromIterable(
        [Dataset.skip("gennaio-01.pdf", "not paired"), { id: "gennaio-02.pdf" }],
        { id: (page) => page.id },
      );

      const loaded = yield* Dataset.load(Dataset.filter({ limit: 1 })(pages));

      expect([idsOf(loaded), loaded.skipped.map((skipped) => skipped.id)]).toEqual([
        [],
        ["gennaio-01.pdf"],
      ]);
    }),
  );
});

describe("Dataset.sample", () => {
  const dataset = Dataset.fromIterable(movements, identify);

  it.effect("draws the same cases for the same seed", () =>
    Effect.gen(function* () {
      const first = yield* Dataset.load(Dataset.sample({ seed: "march", size: 3 })(dataset));
      const second = yield* Dataset.load(Dataset.sample({ seed: "march", size: 3 })(dataset));

      expect(idsOf(first)).toHaveLength(3);
      expect(idsOf(second)).toEqual(idsOf(first));
    }),
  );

  it.effect("keeps the share of each stratum", () =>
    Effect.gen(function* () {
      const loaded = yield* Dataset.load(
        Dataset.sample({ seed: "april", size: 3, stratifyBy: "group" })(dataset),
      );

      expect(loaded.cases.filter((entry) => entry.tags.includes("group:fuel"))).toHaveLength(2);
      expect(loaded.cases.filter((entry) => entry.tags.includes("group:rent"))).toHaveLength(1);
    }),
  );

  it.effect("returns every case when the size is larger than the dataset", () =>
    Effect.gen(function* () {
      const loaded = yield* Dataset.load(Dataset.sample({ seed: "may", size: 50 })(dataset));

      expect(idsOf(loaded).toSorted()).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
    }),
  );
});

describe("Dataset.json", () => {
  it.effect("decodes every element of a JSON array with the schema", () =>
    Effect.gen(function* () {
      const loaded = yield* Dataset.load(
        Dataset.json(MovementSchema, "/data/movements.json", identify),
      );

      expect(loaded.cases).toEqual([
        {
          id: "m1",
          input: { description: "AFFITTO", group: "rent", id: "m1" },
          tags: ["group:rent"],
        },
      ]);
    }).pipe(
      Effect.provide(
        files(
          new Map([
            ["/data/movements.json", '[{"id":"m1","description":"AFFITTO","group":"rent"}]'],
          ]),
        ),
      ),
    ),
  );

  it.effect("fails on an element that does not match the schema", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        Dataset.load(Dataset.json(MovementSchema, "/data/movements.json", identify)),
      );

      expect(failure).toMatchObject({
        message: "Entry 1 does not match the schema.",
        path: "/data/movements.json",
      });
    }).pipe(
      Effect.provide(
        files(
          new Map([
            [
              "/data/movements.json",
              '[{"id":"m1","description":"AFFITTO","group":"rent"},{"id":"m2"}]',
            ],
          ]),
        ),
      ),
    ),
  );

  it.effect("fails when the file cannot be read", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        Dataset.load(Dataset.json(MovementSchema, "/data/missing.json", identify)),
      );

      expect(failure).toMatchObject({
        message: "The dataset file cannot be read.",
        path: "/data/missing.json",
      });
    }).pipe(Effect.provide(files(new Map()))),
  );
});

describe("Dataset.jsonl", () => {
  it.effect("decodes one case per non empty line", () =>
    Effect.gen(function* () {
      const loaded = yield* Dataset.load(
        Dataset.jsonl(MovementSchema, "/data/movements.jsonl", identify),
      );

      expect(idsOf(loaded)).toEqual(["m1", "m2"]);
    }).pipe(
      Effect.provide(
        files(
          new Map([
            [
              "/data/movements.jsonl",
              '{"id":"m1","description":"AFFITTO","group":"rent"}\n\n{"id":"m2","description":"ENI","group":"fuel"}\n',
            ],
          ]),
        ),
      ),
    ),
  );
});

describe("Dataset.directory", () => {
  it.effect("reads the files with the extension in name order", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const loaded = yield* Dataset.load(
        Dataset.directory("/pages", {
          extension: ".txt",
          id: (page: { readonly file: string; readonly text: string }) => page.file,
          read: (file) => fs.readFileString(file).pipe(Effect.map((text) => ({ file, text }))),
        }),
      );

      expect(loaded.cases.map((entry) => entry.input)).toEqual([
        { file: "/pages/a.txt", text: "page a" },
        { file: "/pages/b.txt", text: "page b" },
      ]);
    }).pipe(
      Effect.provide(
        files(
          new Map([
            ["/pages/b.txt", "page b"],
            ["/pages/a.txt", "page a"],
            ["/pages/notes.md", "skip me"],
          ]),
        ),
      ),
    ),
  );
});

describe("Dataset.optional", () => {
  const real = Dataset.optional(
    Config.String("RECONCILIATION_EVAL_DATASET"),
    MovementSchema,
    identify,
  );
  const disk = files(
    new Map([["/secret/real.json", '[{"id":"r1","description":"BONIFICO","group":"bank"}]']]),
  );

  it.effect("is empty when the config is missing", () =>
    Effect.gen(function* () {
      const loaded = yield* Dataset.load(real);

      expect(loaded.cases).toEqual([]);
    }).pipe(
      Effect.provide(disk),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
    ),
  );

  it.effect("reads the file the config names", () =>
    Effect.gen(function* () {
      const loaded = yield* Dataset.load(real);

      expect(idsOf(loaded)).toEqual(["r1"]);
    }).pipe(
      Effect.provide(disk),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ RECONCILIATION_EVAL_DATASET: "/secret/real.json" }),
        ),
      ),
    ),
  );

  it("is sensitive, and stays sensitive through filter, sample, guard and concat", () => {
    const inMemory = Dataset.fromIterable(movements, identify);

    expect([
      inMemory.sensitive,
      real.sensitive,
      Dataset.filter({ limit: 1 })(real).sensitive,
      Dataset.sample({ seed: "s", size: 1 })(real).sensitive,
      Dataset.guard({ rules: [] })(real).sensitive,
      Dataset.concat(real)(inMemory).sensitive,
      Dataset.concat(inMemory)(real).sensitive,
      Dataset.concat(inMemory)(inMemory).sensitive,
    ]).toEqual([false, true, true, true, true, true, true, false]);
  });
});

describe("Dataset.guard", () => {
  const privacy = {
    denylist: Config.succeed(["rossi"]),
    rules: [{ name: "iban", pattern: /IT\d{2}[A-Z]\d{10}/u }],
  };

  it.effect("scans the strings decoding adds to a file entry, as well as the raw entry", () =>
    Effect.gen(function* () {
      const DefaultedSchema = Schema.Struct({
        description: Schema.String.pipe(
          Schema.withDecodingDefaultKey(Effect.succeed("IT60X0542811101000000123456")),
        ),
        id: Schema.String,
        note: Schema.optionalKey(Schema.String),
      });
      const strict = Schema.Struct({ id: Schema.String });
      const guarded = <S extends Schema.Codec<{ readonly id: string }, Schema.Json>>(schema: S) =>
        Effect.flip(
          Dataset.load(
            Dataset.guard(privacy)(
              Dataset.json(schema, "/data/cases.json", { id: (input) => input.id }),
            ),
          ),
        );

      const defaulted = yield* guarded(DefaultedSchema);
      const dropped = yield* guarded(strict);

      expect(defaulted).toMatchObject({
        findings: [
          { case: "one", path: "description", rule: "iban" },
          { case: "one", path: "note", rule: "denylist: rossi" },
        ],
      });
      expect(dropped).toMatchObject({
        findings: [{ case: "one", path: "note", rule: "denylist: rossi" }],
      });
    }).pipe(
      Effect.provide(files(new Map([["/data/cases.json", '[{"id":"one","note":"Rossi"}]']]))),
    ),
  );

  it.effect("fails on a decoded file input it cannot scan as JSON, such as a Date", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        Dataset.load(
          Dataset.guard(privacy)(
            Dataset.json(Schema.DateFromString, "/data/dates.json", { id: () => "d1" }),
          ),
        ),
      );

      expect(failure).toMatchObject({
        findings: [{ case: "d1", path: "", rule: "not JSON: the input cannot be scanned" }],
      });
    }).pipe(Effect.provide(files(new Map([["/data/dates.json", '["2026-01-01"]']])))),
  );

  it.effect("lets a clean dataset through", () =>
    Effect.gen(function* () {
      const loaded = yield* Dataset.load(
        Dataset.guard(privacy)(Dataset.fromIterable(movements, identify)),
      );

      expect(loaded.cases).toHaveLength(6);
    }),
  );

  it.effect("fails with every finding and the path of the string it is in", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        Dataset.load(
          Dataset.guard(privacy)(
            Dataset.fromIterable(
              [{ description: "BONIFICO IT60X0542811101 MARIO ROSSI", group: "bank", id: "m7" }],
              identify,
            ),
          ),
        ),
      );

      expect(failure).toMatchObject({
        findings: [
          { case: "m7", path: "description", rule: "iban" },
          { case: "m7", path: "description", rule: "denylist: rossi" },
        ],
      });
    }),
  );

  it.effect("fails on an input it cannot scan as JSON", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        Dataset.load(
          Dataset.guard(privacy)(
            Dataset.fromIterable([new Map([["id", "m8"]])], { id: () => "m8" }),
          ),
        ),
      );

      expect(failure).toMatchObject({
        findings: [{ case: "m8", path: "", rule: "not JSON: the input cannot be scanned" }],
      });
    }),
  );
});
