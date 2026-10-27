import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Result, Schema, Stream } from "effect";
import * as Agreement from "../src/agreement.ts";
import * as Compare from "../src/compare.ts";
import * as Dataset from "../src/dataset.ts";
import { EvalConfigError } from "../src/errors/eval-config-error.ts";
import * as Eval from "../src/eval.ts";
import type { EvalEvent, Scored } from "../src/events.ts";
import * as Metric from "../src/metric.ts";
import { whenDefined } from "../src/object.ts";
import * as Observation from "../src/observation.ts";
import * as Reporter from "../src/reporter.ts";
import * as Run from "../src/run.ts";
import * as Runner from "../src/runner.ts";
import * as Scorer from "../src/scorer.ts";
import * as Usage from "../src/usage.ts";
import { runOf, scoredAs } from "./fixtures.ts";

const detail = { actual: "", expected: "" };

const scored = (id: string, right: boolean, trial = 1): Scored => ({
  case: id,
  observation: Observation.compared({
    agreement: right ? Agreement.exact : Agreement.different,
    detail,
    key: id,
  }),
  trial,
  variant: "default",
});

const variantOf = (observations: readonly Scored[], trials = 1) =>
  Run.variantRun("default", observations, trials, Usage.empty, 0);

describe("Run.fold", () => {
  it.effect("rebuilds from the events the run the runner returned", () =>
    Effect.gen(function* () {
      const events: EvalEvent[] = [];

      const categorize = Eval.make({
        dataset: Dataset.fromIterable(["m1", "m2", Dataset.skip("m3", "no truth")], {
          id: (id: string) => id,
        }),
        name: "categorizer",
        score: Scorer.label<string, string>({
          actual: Option.some,
          expected: () => Scorer.present("m1"),
        }),
        task: (input) => Effect.succeed(input.input),
      });

      const run = yield* Runner.run(categorize).pipe(
        Effect.provide(
          Reporter.layer([
            Reporter.fromStream(
              "recording",
              Stream.runForEach((event) => Effect.sync(() => events.push(event))),
            ),
          ]),
        ),
      );

      const folded = yield* Run.fold(events);

      expect(folded).toMatchObject({
        eval: "categorizer",
        id: run.id,
        interrupted: false,
        passed: true,
        skipped: [{ id: "m3", reason: "no truth" }],
      });
      expect(folded.variants[0]?.summary).toEqual(run.variants[0]?.summary);
      expect(folded.outputs.map((output) => output.case)).toEqual(["m1", "m2"]);
    }),
  );

  it.effect("marks a run without RunFinished as interrupted and not passed", () =>
    Effect.gen(function* () {
      const events: EvalEvent[] = [];

      const categorize = Eval.make({
        dataset: Dataset.fromIterable(["m1"], { id: (id: string) => id }),
        name: "categorizer",
        score: Scorer.label<string, string>({ actual: Option.some, expected: Scorer.present }),
        task: (input) => Effect.succeed(input.input),
      });

      yield* Runner.run(categorize).pipe(
        Effect.provide(
          Reporter.layer([
            Reporter.fromStream(
              "recording",
              Stream.runForEach((event) => Effect.sync(() => events.push(event))),
            ),
          ]),
        ),
      );

      const folded = yield* Run.fold(events.slice(0, 3));

      expect(folded).toMatchObject({ interrupted: true, passed: false });
      expect(folded.variants[0]?.summary.counts["right"]).toBe(1);
    }),
  );

  it.effect("fails on events without RunStarted", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(Run.fold([]));

      expect(failure.message).toBe("The events of the run have no RunStarted.");
    }),
  );
});

describe("Run.succeededObservations", () => {
  it("filters by task success, case, variant and trial rather than the observation verdict", () => {
    const entries = [
      { case: "page-a", failure: Option.none<string>(), trial: 1, variant: "small" },
      { case: "page-a", failure: Option.some("model down"), trial: 2, variant: "small" },
      { case: "page-a", failure: Option.some("model down"), trial: 1, variant: "large" },
      { case: "page-b", failure: Option.none<string>(), trial: 1, variant: "small" },
    ];

    const base = runOf(
      "excluded",
      entries.map(({ case: id, trial, variant }) => ({
        ...scoredAs({ case: id, right: false, trial, variant }),
        observation: Observation.exclude("pending")(scoredAs({ right: false }).observation),
      })),
      2,
    );

    const run = {
      ...base,
      outputs: entries.map((entry) => ({
        ...entry,
        inputHash: "h",
        judgements: [],
        output: Option.none<Schema.Json>(),
        outputError: Option.none<string>(),
      })),
    };

    const succeeded = Run.succeededObservations(run);
    expect(succeeded.map((entry) => [entry.variant, entry.case, entry.trial])).toEqual([
      ["small", "page-a", 1],
      ["small", "page-b", 1],
    ]);
    expect(
      Metric.read(
        Metric.summary(succeeded.map((entry) => entry.observation)),
        Metric.excluded("pending"),
      ),
    ).toBe(2);
    expect(
      base.variants.map((variant) => Metric.read(variant.summary, Metric.excluded("pending"))),
    ).toEqual([3, 1]);
  });
});

describe("Run.compare", () => {
  const baseline = runOf("base", [
    scoredAs({ case: "a", right: true }),
    scoredAs({ case: "b", right: true }),
    scoredAs({ case: "c", right: false }),
    scoredAs({ case: "d", right: false }),
    scoredAs({ case: "gone", right: true }),
  ]);

  const run = runOf("head", [
    scoredAs({ case: "a", right: true }),
    scoredAs({ case: "b", right: false }),
    scoredAs({ case: "c", right: true }),
    scoredAs({ case: "d", right: true }),
    scoredAs({ case: "new", right: true }),
  ]);

  const comparison = Run.compare(run, baseline);

  it("lists the regressions and the fixes with their verdicts", () => {
    expect(
      comparison.regressions.map((transition) => [transition.case, transition.from, transition.to]),
    ).toEqual([["b", "right", "wrong"]]);
    expect(comparison.fixes.map((transition) => transition.case)).toEqual(["c", "d"]);
  });

  it("lists the observations added and removed since the baseline", () => {
    expect(comparison.added.map(Run.observationLabel)).toEqual(["default · new/new · trial 1"]);
    expect(comparison.removed.map(Run.observationLabel)).toEqual(["default · gone/gone · trial 1"]);
  });

  it("finds added and removed observations by variant, case, key and trial, not by their labels", () => {
    const renamed = Run.compare(
      runOf("head", [
        scoredAs({ case: "reasoning=b · case", key: "", right: true, variant: "model=a" }),
      ]),
      runOf("base", [
        scoredAs({ case: "case", key: "", right: true, variant: "model=a · reasoning=b" }),
      ]),
    );

    const moreTrials = Run.compare(
      runOf("head", [scoredAs({ right: true, trial: 1 }), scoredAs({ right: true, trial: 2 })], 2),
      runOf("base", [scoredAs({ right: true, trial: 1 })]),
    );

    expect([renamed.added.length, renamed.removed.length]).toEqual([1, 1]);
    expect([moreTrials.added.map((entry) => entry.trial), moreTrials.removed]).toEqual([[2], []]);
  });

  it("counts the transitions between verdict classes", () => {
    expect(
      comparison.transitions
        .filter((count) => count.count > 0)
        .map((count) => [count.from, count.to, count.count]),
    ).toEqual([
      ["right", "right", 1],
      ["right", "wrong", 1],
      ["wrong", "right", 2],
    ]);
  });

  it("gives the delta of every ratio over the paired observations, with the McNemar p-value only on accuracy", () => {
    const accuracy = comparison.deltas.find((row) => row.metric === "accuracy");
    const others = comparison.deltas.filter((row) => row.metric !== "accuracy");

    expect(accuracy).toMatchObject({
      after: { n: 4, value: Option.some(0.75) },
      before: { n: 4, value: Option.some(0.5) },
      variant: "default",
    });
    expect(Option.getOrUndefined(accuracy?.delta ?? Option.none())).toBeCloseTo(0.25);
    expect(Option.getOrUndefined(accuracy?.pValue ?? Option.none())).toBeCloseTo(1);
    expect(others.map((row) => row.pValue)).toEqual(others.map(() => Option.none()));
  });

  it("pairs an observation only with the same variant and trial", () => {
    const moved = Run.compare(
      runOf(
        "head",
        [scoredAs({ right: false, trial: 2 }), scoredAs({ right: false, variant: "large" })],
        2,
      ),
      runOf("base", [scoredAs({ right: true, trial: 1 })], 2),
    );

    expect(moved.regressions).toEqual([]);
  });
});

describe("Run.compare with sub-cases", () => {
  it.effect("keeps sub-cases with the same inner key apart in comparisons and trials", () =>
    Effect.gen(function* () {
      const statements = Eval.make({
        dataset: Dataset.fromIterable(["statement"], { id: (id: string) => id }),
        name: "statements",
        score: Scorer.each<string, ReadonlyMap<string, boolean>, string, boolean, never>(
          {
            actual: (output) => output,
            expected: () => [
              { id: "A", input: "A", tags: [] },
              { id: "B", input: "B", tags: [] },
            ],
          },
          Scorer.make((_input, outcome) =>
            Effect.succeed([
              Observation.compared({
                agreement: Option.contains(Option.flatten(Result.getSuccess(outcome)), true)
                  ? Agreement.exact
                  : Agreement.different,
                detail,
                key: "field",
              }),
            ]),
          ),
        ),
        task: () =>
          Effect.succeed(
            new Map([
              ["A", false],
              ["B", true],
            ]),
          ),
        trials: 2,
      });

      const run = yield* Runner.run(statements);
      const trials = Option.getOrUndefined(run.variants[0]?.trials ?? Option.none());

      expect(Run.compare(run, run).regressions).toEqual([]);
      expect([trials?.passAtK, trials?.passHatK, trials?.flaky]).toEqual([
        Option.some(0.5),
        Option.some(0.5),
        [],
      ]);
    }),
  );
});

const unchanged = (run: Run.Run) => {
  const comparison = Run.compare(run, run);

  return {
    changedTransitions: comparison.transitions.filter(
      (count) => count.from !== count.to && count.count > 0,
    ),
    deltas: [
      ...new Set(
        comparison.deltas.flatMap((row) => Option.toArray(row.delta)).map((delta) => delta),
      ),
    ].filter((delta) => delta !== 0),
    fixes: comparison.fixes,
    regressions: comparison.regressions,
  };
};

const clean = { changedTransitions: [], deltas: [], fixes: [], regressions: [] };

const TRICKY = Schema.Literals(["", "/", "\\", "a", "b", "a/b", "a\\/b", "\\/", "\\_"]);

const casesOf = (ids: readonly string[]) =>
  [...new Set(ids)].map((id) => ({ id, input: id, tags: [] }));

const answers = (keys: { readonly first?: string; readonly second?: string }) =>
  Eval.make({
    dataset: Dataset.fromIterable(["case"], { id: (id: string) => id }),
    name: "answers",
    score: Scorer.all<string, { readonly first: string; readonly second: string }, never>(
      Scorer.label({
        actual: (output) => Option.some(output.first),
        expected: () => Scorer.present("yes"),
        ...whenDefined(keys.first, (key) => ({ key })),
      }),
      Scorer.label({
        actual: (output) => Option.some(output.second),
        expected: () => Scorer.present("yes"),
        ...whenDefined(keys.second, (key) => ({ key })),
      }),
    ),
    task: () => Effect.succeed({ first: "yes", second: "no" }),
    trials: 2,
  });

const rightWhen = (id: string) => (id.length % 2 === 0 ? id : `not ${id}`);

describe("Run.compare with composed scorers", () => {
  it.effect("keeps a sub-case apart from a sub-case whose id holds a slash", () =>
    Effect.gen(function* () {
      const statements = Eval.make({
        dataset: Dataset.fromIterable(["statement"], { id: (id: string) => id }),
        name: "statements",
        score: Scorer.each<string, ReadonlyMap<string, boolean>, string, boolean, never>(
          {
            actual: (output) => output,
            expected: () => casesOf(["a", "a/b"]),
          },
          Scorer.make((input, outcome) =>
            Effect.succeed([
              Observation.compared({
                agreement: Option.contains(Option.flatten(Result.getSuccess(outcome)), true)
                  ? Agreement.exact
                  : Agreement.different,
                detail,
                key: input.id === "a" ? Observation.keyOf("b") : Observation.rootKey,
              }),
            ]),
          ),
        ),
        task: () =>
          Effect.succeed(
            new Map([
              ["a", false],
              ["a/b", true],
            ]),
          ),
      });

      const run = yield* Runner.run(statements);

      expect(run.variants[0]?.observations.map((entry) => entry.observation.key)).toEqual([
        "a/b",
        "a\\/b",
      ]);
      expect(unchanged(run)).toEqual(clean);
    }),
  );

  it.effect(
    "refuses two scorers that claim the same key, and keeps them apart with their own keys",
    () =>
      Effect.gen(function* () {
        const refused = yield* Effect.flip(Runner.run(answers({})));
        const run = yield* Runner.run(answers({ first: "first", second: "second" }));
        const trials = Option.getOrUndefined(run.variants[0]?.trials ?? Option.none());

        expect(refused).toBeInstanceOf(EvalConfigError);
        expect(refused).toMatchObject({ path: "score" });
        expect(unchanged(run)).toEqual(clean);
        expect([trials?.passAtK, trials?.passHatK, trials?.flaky]).toEqual([
          Option.some(0.5),
          Option.some(0.5),
          [],
        ]);
      }),
  );

  it.effect.prop(
    "never merges two observations of a nested composition, so a self-comparison changes nothing",
    {
      fields: Schema.Array(TRICKY),
      nested: Schema.Array(TRICKY),
      subs: Schema.Array(TRICKY),
    },
    ({ fields, nested, subs }) =>
      Effect.gen(function* () {
        const inner = Scorer.all<string, Option.Option<string>, never>(
          Scorer.label({
            actual: (output) => output,
            expected: (id) => Scorer.present(rightWhen(id)),
          }),
          Scorer.fields({
            expected: (id: string) => Option.some(id),
            fields: [...new Set(fields)].map((key) => ({
              compare: Compare.exact<string>(),
              group: "field",
              key,
              read: (record: Option.Option<string>) =>
                record.pipe(Option.map((value) => rightWhen(`${value}${key}`))),
            })),
            onlyActual: Scorer.onlyActualPolicies.exclude,
          }),
          Scorer.each<string, Option.Option<string>, string, string, never>(
            {
              actual: (output) =>
                new Map(
                  casesOf(nested).map((item) => [
                    item.id,
                    `${Option.getOrElse(output, () => "")}${item.id}`,
                  ]),
                ),
              expected: () => casesOf(nested),
            },
            Scorer.label({
              actual: (output) => output,
              expected: (id) => Scorer.present(rightWhen(id)),
              key: "row",
            }),
          ),
        );

        const composed = Eval.make({
          dataset: Dataset.fromIterable(["case"], { id: (id: string) => id }),
          name: "composed",
          score: Scorer.all<string, ReadonlyMap<string, string>, never>(
            Scorer.label({
              actual: () => Option.some("x"),
              expected: () => Scorer.present("x"),
              key: "top",
            }),
            Scorer.each({ actual: (output) => output, expected: () => casesOf(subs) }, inner),
          ),
          task: () => Effect.succeed(new Map(casesOf(subs).map((item) => [item.id, item.id]))),
          trials: 2,
        });

        const run = yield* Runner.run(composed);
        const trials = Option.getOrUndefined(run.variants[0]?.trials ?? Option.none());

        const identities = run.variants.flatMap((variant) =>
          variant.observations.map((entry) =>
            JSON.stringify([entry.case, entry.trial, entry.observation.key]),
          ),
        );

        expect(new Set(identities).size).toBe(identities.length);
        expect(unchanged(run)).toEqual(clean);
        expect([trials?.passAtK, trials?.flaky]).toEqual([trials?.passHatK, []]);
      }),
    { timeout: 30_000 },
  );
});

const excludedAs = (id: string): Scored => {
  const base = scoredAs({ case: id, right: false });

  return { ...base, observation: Observation.exclude("convention")(base.observation) };
};

const accuracyDelta = (comparison: Run.Comparison) =>
  comparison.deltas.find((row) => row.metric === "accuracy");

describe("Run.compare McNemar", () => {
  it("counts only the pairs that accuracy measures on both sides", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];

    const comparison = Run.compare(
      runOf(
        "head",
        [...ids, "i"].map((id) => scoredAs({ case: id, right: true })),
      ),
      runOf("base", [...ids.map(excludedAs), scoredAs({ case: "i", right: false })]),
    );

    expect(accuracyDelta(comparison)?.pValue).toEqual(Option.some(1));
  });

  it("has no p-value when no pair is measured on both sides", () => {
    const comparison = Run.compare(
      runOf("head", [scoredAs({ case: "a", right: true })]),
      runOf("base", [excludedAs("a")]),
    );

    expect(accuracyDelta(comparison)?.pValue).toEqual(Option.none());
  });
});

describe("Run.compare delta intervals", () => {
  const ids = Array.from({ length: 20 }, (_, index) => `case-${String(index)}`);

  const comparison = Run.compare(
    runOf(
      "head",
      ids.map((id, index) => scoredAs({ case: id, right: index < 16 })),
    ),
    runOf(
      "base",
      ids.map((id, index) => scoredAs({ case: id, right: index < 10 })),
    ),
  );

  it("gives each delta a paired interval around it", () => {
    const accuracy = accuracyDelta(comparison);
    const delta = Option.getOrElse(accuracy?.delta ?? Option.none(), () => Number.NaN);

    const [low, high] = Option.getOrElse(accuracy?.interval ?? Option.none(), () => [
      Number.NaN,
      Number.NaN,
    ]);

    expect(delta).toBeCloseTo(0.3);
    expect(low).toBeLessThan(delta);
    expect(high).toBeGreaterThan(delta);
    expect(low).toBeGreaterThan(0);
  });

  it("has no interval without paired observations", () => {
    const unpairedComparison = Run.compare(
      runOf("head", [scoredAs({ case: "a", right: true })]),
      runOf("base", [scoredAs({ case: "b", right: true })]),
    );

    expect(accuracyDelta(unpairedComparison)?.interval).toEqual(Option.none());
    expect(accuracyDelta(unpairedComparison)?.delta).toEqual(Option.none());
  });

  it("measures the delta and its interval on the observations both runs have", () => {
    const removedOne = Run.compare(
      runOf("head", [scoredAs({ case: "paired", right: true })]),
      runOf("base", [
        scoredAs({ case: "paired", right: true }),
        scoredAs({ case: "removed", right: false }),
      ]),
    );

    const addedNine = Run.compare(
      runOf("head", [
        scoredAs({ case: "paired", right: true }),
        ...Array.from({ length: 9 }, (_, index) =>
          scoredAs({ case: `added-${String(index)}`, right: false }),
        ),
      ]),
      runOf("base", [scoredAs({ case: "paired", right: true })]),
    );

    expect(
      [removedOne, addedNine].map((compared) => {
        const accuracy = accuracyDelta(compared);

        return [accuracy?.before.value, accuracy?.after.value, accuracy?.delta, accuracy?.interval];
      }),
    ).toEqual([
      [Option.some(1), Option.some(1), Option.some(0), Option.some([0, 0])],
      [Option.some(1), Option.some(1), Option.some(0), Option.some([0, 0])],
    ]);
  });

  it("leaves out a pair whose metric does not measure both sides", () => {
    const accuracy = accuracyDelta(
      Run.compare(
        runOf("head", [
          scoredAs({ case: "a", right: false }),
          scoredAs({ case: "b", right: true }),
        ]),
        runOf("base", [scoredAs({ case: "a", right: true }), excludedAs("b")]),
      ),
    );

    expect([accuracy?.before.n, accuracy?.delta, accuracy?.interval]).toEqual([
      1,
      Option.some(-1),
      Option.some([-1, -1]),
    ]);
  });
});

describe("Run.variantRun trial stats", () => {
  it("has no trial stats for a single trial", () => {
    expect(variantOf([scored("a", true)]).trials).toEqual(Option.none());
  });

  it("finds flaky cases and estimates pass@k and pass^k", () => {
    const run = variantOf(
      [scored("a", true, 1), scored("a", true, 2), scored("b", true, 1), scored("b", false, 2)],
      2,
    );

    const trials = Option.getOrUndefined(run.trials);

    expect(trials?.flaky.map((group) => group.case)).toEqual(["b"]);
    expect(trials?.passAtK).toEqual(Option.some(1));
    expect(trials?.passHatK).toEqual(Option.some(0.5));
    expect(trials?.metrics["accuracy"]).toEqual({
      mean: Option.some(0.75),
      standardDeviation: Option.some(Math.SQRT1_2 / 2),
    });
  });

  it("gives the mean and deviation of every count metric across trials", () => {
    const run = variantOf(
      [scored("a", true, 1), scored("b", true, 1), scored("a", false, 2), scored("b", false, 2)],
      2,
    );

    const trials = Option.getOrUndefined(run.trials);

    expect([trials?.metrics["wrong"], trials?.metrics["right"]]).toEqual([
      { mean: Option.some(1), standardDeviation: Option.some(Math.SQRT2) },
      { mean: Option.some(1), standardDeviation: Option.some(Math.SQRT2) },
    ]);
    expect(Object.keys(trials?.metrics ?? {})).toEqual([
      ...Metric.counts.map((metric) => metric.name),
      ...Metric.ratios.map((metric) => metric.name),
    ]);
  });

  it("leaves excluded and unscored observations out of pass@k and pass^k", () => {
    const excluded = (trial: number) => ({
      ...scored("x", true, trial),
      observation: Observation.exclude("convention")(scored("x", true, trial).observation),
    });

    const run = variantOf(
      [scored("a", true, 1), scored("a", true, 2), excluded(1), excluded(2)],
      2,
    );

    const trials = Option.getOrUndefined(run.trials);

    expect(trials?.passAtK).toEqual(Option.some(1));
    expect(trials?.passHatK).toEqual(Option.some(1));
    expect(trials?.flaky).toEqual([]);
  });

  it("keeps k and leaves out an observation measured in fewer than k trials", () => {
    const excluded = (id: string, trial: number) => ({
      ...scored(id, true, trial),
      observation: Observation.exclude("convention")(scored(id, true, trial).observation),
    });

    const short = Option.getOrUndefined(
      variantOf([scored("x", true, 1), excluded("x", 2)], 2).trials,
    );

    const mixed = Option.getOrUndefined(
      variantOf(
        [scored("a", true, 1), scored("a", false, 2), scored("x", true, 1), excluded("x", 2)],
        2,
      ).trials,
    );

    expect([short?.k, short?.passAtK, short?.passHatK, short?.shortOfK]).toEqual([
      2,
      Option.none(),
      Option.none(),
      1,
    ]);
    expect([mixed?.passAtK, mixed?.passHatK, mixed?.shortOfK]).toEqual([
      Option.some(1),
      Option.some(0),
      1,
    ]);
  });

  it("reports a metric no trial can measure as unmeasured, not as zero", () => {
    const excluded = (trial: number) => ({
      ...scored("x", true, trial),
      observation: Observation.exclude("convention")(scored("x", true, trial).observation),
    });

    const trials = Option.getOrUndefined(variantOf([excluded(1), excluded(2)], 2).trials);

    expect(trials?.metrics["accuracy"]).toEqual({
      mean: Option.none(),
      standardDeviation: Option.none(),
    });
    expect(trials?.passAtK).toEqual(Option.none());
  });
});
