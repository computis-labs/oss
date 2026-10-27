import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Effect, Equivalence, Option, Result } from "effect";
import * as Compare from "../src/compare.ts";
import type { Case } from "../src/dataset.ts";
import * as Observation from "../src/observation.ts";
import * as Scorer from "../src/scorer.ts";
import * as Verdict from "../src/verdict.ts";
import { verdicts } from "../src/verdict.ts";

const caseOf = <A>(id: string, input: A, tags: readonly string[] = []): Case<A> => ({
  id,
  input,
  tags,
});

const verdictsOf = (observations: readonly Observation.Observation[]) =>
  observations.map((observation) => [observation.key, Verdict.of(observation)]);

describe("Scorer.label", () => {
  const scorer = Scorer.label<{ readonly expected: string | null }, string | null>({
    actual: Option.fromNullishOr,
    expected: (input) => (input.expected === null ? Scorer.absent : Scorer.present(input.expected)),
  });

  it.effect("scores the output against the expected label under the case itself and its tags", () =>
    Effect.gen(function* () {
      const [observation] = yield* scorer(
        caseOf("m1", { expected: "rent" }, ["bank:intesa"]),
        Result.succeed("rent"),
      );

      expect(observation).toMatchObject({
        detail: { actual: "rent", expected: "rent" },
        key: Observation.rootKey,
        tags: ["bank:intesa"],
      });
      expect(observation === undefined ? undefined : Verdict.of(observation)).toBe(verdicts.right);
    }),
  );

  it.effect("uses the key it receives, escaped as one segment", () =>
    Effect.gen(function* () {
      const named = Scorer.label<string, string>({
        actual: Option.some,
        expected: Scorer.present,
        key: "category/main",
      });

      const [observation] = yield* named(caseOf("m1", "rent"), Result.succeed("rent"));

      expect(observation?.key).toBe("category\\/main");
    }),
  );

  it.effect("calls a label where none was expected wrong and a correct abstention right", () =>
    Effect.gen(function* () {
      const answered = yield* scorer(caseOf("m2", { expected: null }), Result.succeed("rent"));
      const abstained = yield* scorer(caseOf("m3", { expected: null }), Result.succeed(null));

      expect([...verdictsOf(answered), ...verdictsOf(abstained)]).toEqual([
        [Observation.rootKey, verdicts.wrong],
        [Observation.rootKey, verdicts.right],
      ]);
    }),
  );

  it.effect("records a failed task as errored with the expected label", () =>
    Effect.gen(function* () {
      const [observation] = yield* scorer(
        caseOf("m4", { expected: "fuel" }),
        Result.fail("timeout"),
      );

      expect(observation).toMatchObject({
        detail: { actual: "", expected: "fuel" },
        failure: Option.some("timeout"),
      });
    }),
  );

  it.effect("uses the comparator it receives", () =>
    Effect.gen(function* () {
      const lenient = Scorer.label<string, string>({
        actual: Option.some,
        compare: Compare.normalizedText(),
        expected: Scorer.present,
      });

      const observations = yield* lenient(caseOf("m5", "Affitto"), Result.succeed("  AFFITTO "));

      expect(verdictsOf(observations)).toEqual([[Observation.rootKey, verdicts.right]]);
    }),
  );
});

describe("Scorer.set", () => {
  const scorer = Scorer.set<readonly string[], readonly string[], string>({
    actual: (output) => output,
    compare: Compare.subset(Equivalence.String),
    expected: Scorer.present,
    show: (item) => item,
  });

  it.effect("shows both sides joined and gives partial credit to a subset", () =>
    Effect.gen(function* () {
      const [observation] = yield* scorer(
        caseOf("m1", ["INV-1", "INV-2"]),
        Result.succeed(["INV-1"]),
      );

      expect(observation?.detail).toEqual({ actual: "INV-1", expected: "INV-1 + INV-2" });
      expect(observation === undefined ? undefined : Verdict.of(observation)).toBe(
        verdicts.partial,
      );
    }),
  );

  it.effect("treats an empty expected set as no match expected", () =>
    Effect.gen(function* () {
      const abstained = yield* scorer(caseOf("m2", []), Result.succeed([]));
      const answered = yield* scorer(caseOf("m3", []), Result.succeed(["INV-9"]));

      expect([...verdictsOf(abstained), ...verdictsOf(answered)]).toEqual([
        [Observation.rootKey, verdicts.right],
        [Observation.rootKey, verdicts.wrong],
      ]);
    }),
  );
});

interface Invoice {
  readonly tipoDocumento?: string;
  readonly natura?: string;
  readonly denominazione?: string;
  readonly causale?: string;
}

const read = (key: keyof Invoice) => (invoice: Invoice) => Option.fromNullishOr(invoice[key]);

const invoiceFields: readonly Scorer.Field<Invoice>[] = [
  { compare: Compare.exact(), group: "fiscal", key: "tipoDocumento", read: read("tipoDocumento") },
  { compare: Compare.exact(), group: "fiscal", key: "natura", read: read("natura") },
  {
    compare: Compare.tokenSimilarity(),
    exclude: ({ actualValue }) =>
      Option.exists(actualValue, (value) => value.endsWith("SPA"))
        ? Option.some("legal form")
        : Option.none(),
    group: "supplier",
    key: "denominazione",
    read: read("denominazione"),
  },
  {
    compare: Compare.exact(),
    excluded: "free text",
    group: "body",
    key: "causale",
    read: read("causale"),
  },
];

describe("Scorer.fields", () => {
  const scorer = (onlyActual: Scorer.OnlyActual) =>
    Scorer.fields<Invoice, Invoice>({
      expected: (input) => input,
      fields: invoiceFields,
      onlyActual,
    });

  it.effect("scores each field with a group tag and skips fields absent on both sides", () =>
    Effect.gen(function* () {
      const observations = yield* scorer(Scorer.onlyActualPolicies.falsePositive)(
        caseOf("p1", { natura: "N6.3", tipoDocumento: "TD17" }, ["supplier:acme"]),
        Result.succeed({ natura: "N6.1", tipoDocumento: "TD17" }),
      );

      expect(verdictsOf(observations)).toEqual([
        ["tipoDocumento", verdicts.right],
        ["natura", verdicts.wrong],
      ]);
      expect(observations[0]?.tags).toEqual(["supplier:acme", "group:fiscal"]);
    }),
  );

  it.effect("excludes a field marked excluded whatever the values", () =>
    Effect.gen(function* () {
      const observations = yield* scorer(Scorer.onlyActualPolicies.falsePositive)(
        caseOf("p2", { causale: "Canone marzo" }),
        Result.succeed({ causale: "Canone aprile" }),
      );

      expect(observations.map((observation) => observation.excluded)).toEqual([
        Option.some("free text"),
      ]);
    }),
  );

  it.effect(
    "classes a pending field the output alone has as extra, and keeps it pending otherwise",
    () =>
      Effect.gen(function* () {
        const pending = Scorer.fields<Invoice, Invoice>({
          expected: (input) => input,
          fields: [
            {
              compare: Compare.exact(),
              excluded: "pending",
              group: "supplier",
              key: "numeroCivico",
              read: read("causale"),
            },
          ],
          onlyActual: Scorer.onlyActualPolicies.exclude,
        });

        const onlyActual = yield* pending(caseOf("p9", {}), Result.succeed({ causale: "14" }));

        const both = yield* pending(
          caseOf("p9", { causale: "12" }),
          Result.succeed({ causale: "14" }),
        );

        expect([...onlyActual, ...both].map((observation) => observation.excluded)).toEqual([
          Option.some(Scorer.extra),
          Option.some("pending"),
        ]);
      }),
  );

  it.effect("excludes a disagreement the field explains as a known convention", () =>
    Effect.gen(function* () {
      const observations = yield* scorer(Scorer.onlyActualPolicies.falsePositive)(
        caseOf("p3", { denominazione: "ACME Industrie" }),
        Result.succeed({ denominazione: "ACME SPA" }),
      );

      expect(observations.map((observation) => observation.excluded)).toEqual([
        Option.some("legal form"),
      ]);
    }),
  );

  it.effect("consults the convention when the output misses the field", () =>
    Effect.gen(function* () {
      const placeholder = Scorer.fields<Invoice, Invoice>({
        expected: (input) => input,
        fields: [
          {
            compare: Compare.exact(),
            exclude: ({ actualValue, expectedValue }) =>
              expectedValue === "placeholder" && Option.isNone(actualValue)
                ? Option.some("known convention")
                : Option.none(),
            group: "fiscal",
            key: "natura",
            read: read("natura"),
          },
        ],
        onlyActual: Scorer.onlyActualPolicies.falsePositive,
      });

      const missing = yield* placeholder(
        caseOf("p7", { natura: "placeholder" }),
        Result.succeed({}),
      );

      const failed = yield* placeholder(
        caseOf("p8", { natura: "placeholder" }),
        Result.fail("invalid XML"),
      );

      expect(verdictsOf(missing)).toEqual([["natura", verdicts.excluded]]);
      expect(missing[0]?.excluded).toEqual(Option.some("known convention"));
      expect(verdictsOf(failed)).toEqual([["natura", verdicts.errored]]);
    }),
  );

  it.effect("counts a field only the output has as a false positive or excludes it as extra", () =>
    Effect.gen(function* () {
      const input = caseOf("p4", { tipoDocumento: "TD17" });
      const output = Result.succeed({ natura: "N6.3", tipoDocumento: "TD17" });

      const strict = yield* scorer(Scorer.onlyActualPolicies.falsePositive)(input, output);
      const lenient = yield* scorer(Scorer.onlyActualPolicies.exclude)(input, output);

      expect(verdictsOf(strict)).toEqual([
        ["tipoDocumento", verdicts.right],
        ["natura", verdicts.wrong],
      ]);
      expect(verdictsOf(lenient)).toEqual([
        ["tipoDocumento", verdicts.right],
        ["natura", verdicts.excluded],
      ]);
      expect(lenient[1]?.excluded).toEqual(Option.some(Scorer.extra));
    }),
  );

  it.effect("turns a missed field into a known gap when gap gives a reason for its key", () =>
    Effect.gen(function* () {
      const withGaps = Scorer.fields<
        { readonly invoice: Invoice; readonly gaps: Readonly<Record<string, string>> },
        Invoice
      >({
        expected: (page) => page.invoice,
        fields: invoiceFields,
        gap: (page, key) => Option.fromNullishOr(page.gaps[key]),
        onlyActual: Scorer.onlyActualPolicies.exclude,
      });

      const observations = yield* withGaps(
        caseOf("p6", {
          gaps: { natura: "the PDF prints no natura" },
          invoice: { natura: "N6.3", tipoDocumento: "TD17" },
        }),
        Result.succeed({}),
      );

      expect(verdictsOf(observations)).toEqual([
        ["tipoDocumento", verdicts.missed],
        ["natura", verdicts.gap],
      ]);
      expect(observations[1]?.gap).toEqual(Option.some("the PDF prints no natura"));
    }),
  );

  it.effect("errors every expected field when the task failed", () =>
    Effect.gen(function* () {
      const observations = yield* scorer(Scorer.onlyActualPolicies.falsePositive)(
        caseOf("p5", { natura: "N6.3", tipoDocumento: "TD17" }),
        Result.fail("invalid XML"),
      );

      expect(verdictsOf(observations)).toEqual([
        ["tipoDocumento", verdicts.errored],
        ["natura", verdicts.errored],
      ]);
    }),
  );

  it.effect("scores the uncovered leaves as exclusions under their rule", () =>
    Effect.gen(function* () {
      const leafScorer = Scorer.fields<Invoice, Invoice>({
        expected: (input) => input,
        fields: invoiceFields
          .slice(0, 1)
          .map((field) => ({ ...field, covers: ["Body/TipoDocumento"] })),
        leaves: {
          of: (invoice) =>
            new Map(
              Object.entries({
                "Body/Causale": Option.toArray(Option.fromNullishOr(invoice.causale)),
                "Body/TipoDocumento": Option.toArray(Option.fromNullishOr(invoice.tipoDocumento)),
              }).filter(([, values]) => values.length > 0),
            ),
          rule: (path) => (path.endsWith("Causale") ? Option.some("free text") : Option.none()),
        },
        onlyActual: Scorer.onlyActualPolicies.falsePositive,
      });

      const observations = yield* leafScorer(
        caseOf("p6", { causale: "Canone", tipoDocumento: "TD17" }),
        Result.succeed({ causale: "Canone", tipoDocumento: "TD17" }),
      );

      expect(observations.map((observation) => [observation.key, observation.excluded])).toEqual([
        ["tipoDocumento", Option.none()],
        ["Body/Causale", Option.some("free text")],
      ]);
    }),
  );

  it.effect("excludes a leaf without a rule as unclassified", () =>
    Effect.gen(function* () {
      const leafScorer = Scorer.fields<Invoice, Invoice>({
        expected: (input) => input,
        fields: [],
        leaves: {
          of: (invoice) =>
            new Map([["Body/Natura", Option.toArray(Option.fromNullishOr(invoice.natura))]]),
          rule: () => Option.none(),
        },
        onlyActual: Scorer.onlyActualPolicies.falsePositive,
      });

      const observations = yield* leafScorer(caseOf("p7", { natura: "N6.3" }), Result.succeed({}));

      expect(observations.map((observation) => observation.excluded)).toEqual([
        Option.some(Scorer.unclassified),
      ]);
    }),
  );

  it.effect(
    "leaves the leaves out when the task failed, so a failed output classifies no path",
    () =>
      Effect.gen(function* () {
        const leafScorer = Scorer.fields<Invoice, Invoice>({
          expected: (input) => input,
          fields: invoiceFields.slice(0, 1),
          leaves: {
            of: (invoice) =>
              new Map([["Body/Natura", Option.toArray(Option.fromNullishOr(invoice.natura))]]),
            rule: () => Option.none(),
          },
          onlyActual: Scorer.onlyActualPolicies.falsePositive,
        });

        const observations = yield* leafScorer(
          caseOf("p9", { natura: "N6.3", tipoDocumento: "TD17" }),
          Result.fail("invalid XML"),
        );

        expect(verdictsOf(observations)).toEqual([["tipoDocumento", verdicts.errored]]);
      }),
  );
});

describe("Scorer.each", () => {
  interface StatementMovement {
    readonly id: string;
    readonly invoices: readonly string[];
    readonly gap: string | null;
  }

  interface Statement {
    readonly movements: readonly StatementMovement[];
  }

  const scorer = Scorer.each<
    { readonly movements: readonly { readonly id: string; readonly invoice: string | null }[] },
    ReadonlyMap<string, string>,
    string | null,
    string,
    never
  >(
    {
      actual: (output) => output,
      expected: (statement) =>
        statement.movements.map((movement) => caseOf(movement.id, movement.invoice, ["side:bank"])),
    },
    Scorer.label<string | null, Option.Option<string>>({
      actual: (output) => output,
      expected: (invoice) => (invoice === null ? Scorer.absent : Scorer.present(invoice)),
    }),
  );

  it.effect("scores every item of the case with the tags of both", () =>
    Effect.gen(function* () {
      const observations = yield* scorer(
        caseOf(
          "march",
          {
            movements: [
              { id: "m1", invoice: "INV-1" },
              { id: "m2", invoice: "INV-2" },
              { id: "m3", invoice: null },
            ],
          },
          ["bank:intesa"],
        ),
        Result.succeed(
          new Map([
            ["m1", "INV-1"],
            ["m2", "INV-9"],
          ]),
        ),
      );

      expect(verdictsOf(observations)).toEqual([
        ["m1", verdicts.right],
        ["m2", verdicts.wrong],
        ["m3", verdicts.right],
      ]);
      expect(observations[0]?.tags).toEqual(["bank:intesa", "side:bank"]);
    }),
  );

  it.effect("errors every item when the task failed", () =>
    Effect.gen(function* () {
      const observations = yield* scorer(
        caseOf("april", { movements: [{ id: "m1", invoice: "INV-1" }] }),
        Result.fail("rate limited"),
      );

      expect(verdictsOf(observations)).toEqual([["m1", verdicts.errored]]);
    }),
  );

  it.effect("keeps a present null value present, unlike a missing entry", () =>
    Effect.gen(function* () {
      const nullable = Scorer.each<
        readonly string[],
        ReadonlyMap<string, string | null>,
        string,
        string | null,
        never
      >(
        {
          actual: (output) => output,
          expected: (ids) => ids.map((id) => caseOf(id, "null")),
        },
        Scorer.label<string, Option.Option<string | null>>({
          actual: Option.map((value) => JSON.stringify(value)),
          expected: Scorer.present,
        }),
      );

      const observations = yield* nullable(
        caseOf("march", ["n", "gone"]),
        Result.succeed(new Map([["n", null]])),
      );

      expect(verdictsOf(observations)).toEqual([
        ["n", verdicts.right],
        ["gone", verdicts.missed],
      ]);
    }),
  );

  it.effect(
    "turns the missed items of a sub-case into known gaps when gap gives a reason for it",
    () =>
      Effect.gen(function* () {
        const reconcile = Scorer.each(
          {
            actual: (matches: ReadonlyMap<string, readonly string[]>) => matches,
            expected: (statement: Statement) =>
              statement.movements.map((movement) => caseOf(movement.id, movement)),
            gap: (movement, id) =>
              Option.map(Option.fromNullishOr(movement.gap), (reason) => `${id}: ${reason}`),
          },
          Scorer.set({
            actual: Option.getOrElse(() => []),
            compare: Compare.subset(Equivalence.String),
            expected: (movement) => Scorer.present(movement.invoices),
            show: (invoice) => invoice,
          }),
        );

        expectTypeOf(reconcile).toEqualTypeOf<
          Scorer.Scorer<Statement, ReadonlyMap<string, readonly string[]>>
        >();

        const observations = yield* reconcile(
          caseOf("march", {
            movements: [
              { gap: null, id: "m1", invoices: ["INV-1"] },
              { gap: "the bank sends no reference", id: "m2", invoices: ["INV-2"] },
              { gap: null, id: "m3", invoices: ["INV-3"] },
              { gap: "the bank sends no reference", id: "m4", invoices: ["INV-4"] },
            ],
          }),
          Result.succeed(
            new Map([
              ["m1", ["INV-1"]],
              ["m4", ["INV-4"]],
            ]),
          ),
        );

        expect(verdictsOf(observations)).toEqual([
          ["m1", verdicts.right],
          ["m2", verdicts.gap],
          ["m3", verdicts.missed],
          ["m4", verdicts.right],
        ]);
        expect(observations.map((observation) => observation.gap)).toEqual([
          Option.none(),
          Option.some("m2: the bank sends no reference"),
          Option.none(),
          Option.some("m4: the bank sends no reference"),
        ]);
      }),
  );

  it.effect("puts the sub-case in front of a key the inner scorer chose", () =>
    Effect.gen(function* () {
      const fixedKey = Scorer.each<
        readonly string[],
        ReadonlyMap<string, string>,
        string,
        string,
        never
      >(
        {
          actual: (output) => output,
          expected: (parts) => parts.map((part) => caseOf(part, part)),
        },
        Scorer.make(() =>
          Effect.succeed([
            Observation.errored("field", "not measured", {
              expected: Observation.expectedStates.unknown,
            }),
          ]),
        ),
      );

      const observations = yield* fixedKey(caseOf("march", ["a", "b"]), Result.succeed(new Map()));

      expect(observations.map((observation) => observation.key)).toEqual(["a/field", "b/field"]);
    }),
  );
});

describe("Scorer.all", () => {
  it.effect("joins the observations of every scorer", () =>
    Effect.gen(function* () {
      const both = Scorer.all<string, string, never>(
        Scorer.label({ actual: Option.some, expected: Scorer.present }),
        Scorer.make(() =>
          Effect.succeed([
            Observation.errored(Observation.keyOf("length"), "not measured", {
              expected: Observation.expectedStates.unknown,
            }),
          ]),
        ),
      );

      const observations = yield* both(caseOf("c1", "rent"), Result.succeed("rent"));

      expect(observations.map((observation) => observation.key)).toEqual([
        Observation.rootKey,
        "length",
      ]);
    }),
  );
});
