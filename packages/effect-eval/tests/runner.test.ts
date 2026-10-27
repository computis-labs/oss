import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Config,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  Schedule,
  Schema,
  SchemaTransformation,
  Stream,
  pipe,
} from "effect";
import { LanguageModel, OpenAiStructuredOutput, Telemetry } from "effect/ai";
import type { AiError, Response } from "effect/ai";
import * as Agreement from "../src/agreement.ts";
import { withLive } from "../src/clock.ts";
import * as Dataset from "../src/dataset.ts";
import type { Case } from "../src/dataset.ts";
import { EvalConfigError } from "../src/errors/eval-config-error.ts";
import * as Eval from "../src/eval.ts";
import * as Events from "../src/events.ts";
import type { EvalEvent } from "../src/events.ts";
import * as Execution from "../src/execution.ts";
import * as Gate from "../src/gate.ts";
import * as History from "../src/history.ts";
import * as Judge from "../src/judge.ts";
import * as Metric from "../src/metric.ts";
import { whenDefined } from "../src/object.ts";
import * as Reporter from "../src/reporter.ts";
import * as Reporters from "../src/reporters.ts";
import * as Run from "../src/run.ts";
import * as Runner from "../src/runner.ts";
import * as Scorer from "../src/scorer.ts";
import * as Usage from "../src/usage.ts";
import * as Variant from "../src/variant.ts";
import * as Verdicts from "../src/verdict.ts";
import type * as View from "../src/view.ts";

interface Movement {
  readonly id: string;
  readonly text: string;
  readonly category: string | null;
}

const movements: readonly Movement[] = [
  { category: "rent", id: "m1", text: "AFFITTO UFFICIO" },
  { category: "fuel", id: "m2", text: "ENI STATION" },
  { category: null, id: "m3", text: "GIROCONTO" },
];

const byId = { id: (movement: Movement) => movement.id };

const categoryScorer = Scorer.label<Movement, string | null>({
  actual: (output) => Option.fromNullishOr(output),
  expected: (movement) =>
    movement.category === null ? Scorer.absent : Scorer.present(movement.category),
});

const recording = (sink: EvalEvent[]) =>
  Reporter.fromStream("recording", (events) =>
    Stream.runForEach(events, (event) => Effect.sync(() => sink.push(event))),
  );

const counts = (run: Run.Run) => run.variants[0]?.summary.counts;

describe("Runner.run", () => {
  it.effect("scores every case and folds the summary of the variant", () =>
    Effect.gen(function* () {
      const categorize = Eval.make({
        dataset: Dataset.fromIterable(movements, byId),
        name: "categorizer",
        score: categoryScorer,
        task: (input) => Effect.succeed(input.input.id === "m2" ? "food" : input.input.category),
      });

      const run = yield* Runner.run(categorize);

      expect(counts(run)).toMatchObject({ right: 2, wrong: 1 });
      expect(run.variants[0]?.summary.ratios["accuracy"]?.value).toEqual(Option.some(2 / 3));
    }),
  );

  it.effect("turns a failing task into an errored observation and keeps going", () =>
    Effect.gen(function* () {
      const categorize = Eval.make({
        dataset: Dataset.fromIterable(movements, byId),
        name: "categorizer",
        score: categoryScorer,
        task: (input) =>
          input.input.id === "m1"
            ? Effect.fail("provider down")
            : Effect.succeed(input.input.category),
      });

      const run = yield* Runner.run(categorize);

      expect(counts(run)).toMatchObject({ errored: 1, right: 2 });
      expect(run.outputs.find((output) => output.case === "m1")?.failure).toEqual(
        Option.some("provider down"),
      );
    }),
  );

  it.effect("records the message of the error as the failure of a case", () =>
    Effect.gen(function* () {
      const failures = new Map<string, Effect.Effect<string, unknown>>(
        Object.entries({
          defect: Effect.die(new Error("parser crashed")),
          error: Effect.fail(new Error("rate limited")),
          plain: Effect.fail({ code: 503 }),
          string: Effect.fail("No answer from the model after 3m"),
          tagged: Effect.fail(new Cause.NoSuchElementError("no such invoice")),
          taggedWithoutMessage: Effect.fail(new Cause.NoSuchElementError()),
        }),
      );

      const failing = Eval.make({
        dataset: Dataset.fromIterable(failures.keys(), { id: (kind: string) => kind }),
        name: "failing",
        score: Scorer.label<string, string>({ actual: Option.some, expected: Scorer.present }),
        task: (input) => failures.get(input.input) ?? Effect.succeed(input.input),
      });

      const run = yield* Runner.run(failing);

      expect(
        Object.fromEntries(
          run.outputs.map((output) => [output.case, Option.getOrUndefined(output.failure)]),
        ),
      ).toEqual({
        defect: "parser crashed",
        error: "rate limited",
        plain: '{"code":503}',
        string: "No answer from the model after 3m",
        tagged: "no such invoice",
        taggedWithoutMessage: "NoSuchElementError: NoSuchElementError",
      });
    }),
  );

  it.effect("turns a defect of the task into an errored observation", () =>
    Effect.gen(function* () {
      const categorize = Eval.make({
        dataset: Dataset.fromIterable(movements.slice(0, 1), byId),
        name: "categorizer",
        score: categoryScorer,
        task: () => Effect.die(new Error("parser crashed")),
      });

      const run = yield* Runner.run(categorize);

      expect(counts(run)).toMatchObject({ errored: 1 });
    }),
  );

  it.effect("retries a failing task with the schedule of the eval", () =>
    Effect.gen(function* () {
      const attempts: string[] = [];

      const categorize = Eval.make({
        dataset: Dataset.fromIterable(movements.slice(0, 1), byId),
        name: "categorizer",
        retry: Schedule.recurs(2),
        score: categoryScorer,
        task: (input) =>
          Effect.suspend(() => {
            attempts.push(input.id);

            return attempts.length < 3 ? Effect.fail("rate limited") : Effect.succeed("rent");
          }),
      });

      const run = yield* Runner.run(categorize);

      expect(attempts).toEqual(["m1", "m1", "m1"]);
      expect(counts(run)).toMatchObject({ errored: 0, right: 1 });
    }),
  );

  it.effect("fails the gate when a metric is below its threshold", () =>
    Effect.gen(function* () {
      const categorize = Eval.make({
        dataset: Dataset.fromIterable(movements, byId),
        gates: [Gate.min(Metric.accuracy, 0.9)],
        name: "categorizer",
        score: categoryScorer,
        task: () => Effect.succeed("rent"),
      });

      const run = yield* Runner.run(categorize);
      const failure = yield* Effect.flip(Runner.check(run));

      expect(run.passed).toBe(false);
      expect(
        failure.results.map((result) => result.violations.map((scored) => scored.case)),
      ).toEqual([["m2", "m3"]]);
    }),
  );

  it.effect("publishes events in order to every reporter", () =>
    Effect.gen(function* () {
      const events: EvalEvent[] = [];

      const categorize = Eval.make({
        dataset: Dataset.fromIterable([...movements, Dataset.skip("m4", "no ground truth")], byId),
        name: "categorizer",
        score: categoryScorer,
        task: (input) => Effect.succeed(input.input.category),
      });

      yield* Runner.run(categorize).pipe(Effect.provide(Reporter.layer([recording(events)])));

      expect(events).toMatchObject([
        { _tag: "RunStarted" },
        { _tag: "CaseSkipped", id: "m4", reason: "no ground truth" },
        { _tag: "CaseStarted", case: "m1" },
        { _tag: "CaseFinished", case: "m1" },
        { _tag: "CaseStarted", case: "m2" },
        { _tag: "CaseFinished", case: "m2" },
        { _tag: "CaseStarted", case: "m3" },
        { _tag: "CaseFinished", case: "m3" },
        { _tag: "VariantFinished" },
        { _tag: "RunFinished", passed: true },
      ]);
      expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    }),
  );

  it.effect("hides observation details from reporters that do not accept sensitive data", () =>
    Effect.gen(function* () {
      const events: EvalEvent[] = [];

      const categorize = Eval.make({
        dataset: Dataset.fromIterable(movements, byId),
        name: "categorizer",
        output: Schema.NullOr(Schema.String),
        score: categoryScorer,
        sensitive: true,
        task: (input) => Effect.succeed(input.input.category),
      });

      yield* Runner.run(categorize).pipe(Effect.provide(Reporter.layer([recording(events)])));

      const finished = events.filter(Events.isCaseFinished);
      expect(finished.map((event) => event.observations[0]?.detail.actual)).toEqual([
        "[redacted]",
        "[redacted]",
        "[redacted]",
      ]);
      expect(finished.map((event) => event.output)).toEqual([
        Option.none(),
        Option.none(),
        Option.none(),
      ]);
    }),
  );

  it.effect("refuses a run above the confirmation budget unless confirmed", () =>
    Effect.gen(function* () {
      const categorize = Eval.make({
        budget: { confirmAbove: 2 },
        dataset: Dataset.fromIterable(movements, byId),
        name: "categorizer",
        score: categoryScorer,
        task: (input) => Effect.succeed(input.input.category),
      });

      const refused = yield* Effect.flip(Runner.run(categorize));
      const confirmed = yield* Runner.run(categorize, { confirmed: true });

      expect(refused).toMatchObject({ limit: 2, planned: 3 });
      expect(counts(confirmed)?.["right"]).toBe(3);
    }),
  );

  it.effect("errors the cases left once the run spends its maxCalls", () =>
    Effect.gen(function* () {
      const categorize = Eval.make({
        budget: { maxCalls: 2 },
        dataset: Dataset.fromIterable(movements, byId),
        name: "categorizer",
        score: categoryScorer,
        task: (input) => Usage.record({}).pipe(Effect.as(input.input.category)),
      });

      const run = yield* Runner.run(categorize);

      expect(counts(run)).toMatchObject({ errored: 1, right: 2 });
      expect(run.outputs.find((output) => output.case === "m3")?.failure).toEqual(
        Option.some("budget: the run reached its maxCalls"),
      );
    }),
  );

  it.effect("spends no task call on a setup that failed, so a later trial still runs", () =>
    Effect.gen(function* () {
      const setups: string[] = [];
      const tasks: string[] = [];

      const run = yield* Runner.run(
        Eval.make({
          budget: { maxCalls: 1 },
          dataset: Dataset.fromIterable(["a"], { id: (id: string) => id }),
          name: "setup-budget",
          score: Scorer.label<string, string>({ actual: Option.some, expected: Scorer.present }),
          setup: Effect.suspend(() => {
            setups.push("setup");

            return setups.length === 1 ? Effect.fail("no setup") : Effect.succeed("ready");
          }),
          task: () => Effect.sync(() => tasks.push("task")).pipe(Effect.as("a")),
          trials: 2,
        }),
      );

      expect([setups.length, tasks.length]).toEqual([2, 1]);
      expect(
        run.outputs.map((output) => [
          output.trial,
          output.failure.pipe(Option.map((failure) => failure.split(":")[0])),
        ]),
      ).toEqual([
        [1, Option.some("setup")],
        [2, Option.none()],
      ]);
    }),
  );

  it.effect("times out a slow case on the live clock", () =>
    Effect.gen(function* () {
      const categorize = Eval.make({
        dataset: Dataset.fromIterable(movements.slice(0, 1), byId),
        name: "categorizer",
        score: categoryScorer,
        task: () => Effect.never,
        timeout: Duration.millis(20),
      });

      const run = yield* Runner.run(categorize);

      expect(counts(run)?.["errored"]).toBe(1);
      expect(run.outputs[0]?.failure).toEqual(Option.some("Operation timed out after '20ms'"));
    }),
  );

  it.effect("calls a batched task once per batch with the setup value", () =>
    Effect.gen(function* () {
      const calls: number[] = [];

      const categorize = Eval.makeBatched({
        dataset: Dataset.fromIterable(movements, byId),
        execution: Execution.batched(2),
        name: "categorizer",
        score: categoryScorer,
        setup: Effect.succeed("prompt-v2"),
        task: (inputs, prompt) =>
          Effect.sync(() => {
            calls.push(inputs.length);

            return inputs.map((input) => (prompt === "prompt-v2" ? input.input.category : null));
          }),
      });

      const run = yield* Runner.run(categorize);

      expect(calls).toEqual([2, 1]);
      expect(counts(run)?.["right"]).toBe(3);
    }),
  );

  it.effect("errors the cases a batched task returns no output for", () =>
    Effect.gen(function* () {
      const categorize = Eval.makeBatched({
        dataset: Dataset.fromIterable(movements, byId),
        execution: Execution.whole,
        name: "categorizer",
        score: categoryScorer,
        task: (inputs) => Effect.succeed(inputs.slice(0, 2).map((input) => input.input.category)),
      });

      const run = yield* Runner.run(categorize);

      expect(counts(run)).toMatchObject({ errored: 1, right: 2 });
      expect(run.outputs.find((output) => output.case === "m3")?.failure).toEqual(
        Option.some("The task returned 2 outputs for 3 cases."),
      );
    }),
  );

  it.effect("runs the setup once per trial", () =>
    Effect.gen(function* () {
      const setups: string[] = [];

      const categorize = Eval.make({
        dataset: Dataset.fromIterable(movements, byId),
        name: "categorizer",
        score: categoryScorer,
        setup: Effect.sync(() => setups.push("seeded")),
        task: (input) => Effect.succeed(input.input.category),
        trials: 2,
      });

      yield* Runner.run(categorize);

      expect(setups).toEqual(["seeded", "seeded"]);
    }),
  );

  it.effect("runs each variant with its own layer", () =>
    Effect.gen(function* () {
      const Answer = Context.Reference<string>("Answer", { defaultValue: () => "rent" });

      const categorize = Eval.make({
        dataset: Dataset.fromIterable(movements.slice(0, 1), byId),
        name: "categorizer",
        score: categoryScorer,
        task: () => Effect.service(Answer),
      });

      const run = yield* Runner.run(categorize, {
        variants: [
          Variant.make("good", Layer.succeed(Answer, "rent")),
          Variant.make("bad", Layer.succeed(Answer, "fuel")),
        ],
      });

      expect(
        run.variants.map((variant) => [variant.variant, variant.summary.counts["right"]]),
      ).toEqual([
        ["good", 1],
        ["bad", 0],
      ]);
    }),
  );

  it.effect("records the usage the task reports through the meter", () =>
    Effect.gen(function* () {
      const categorize = Eval.make({
        dataset: Dataset.fromIterable(movements, byId),
        name: "categorizer",
        score: categoryScorer,
        task: (input) =>
          Usage.record({ costUsd: 0.01, inputTokens: 100 }).pipe(Effect.as(input.input.category)),
      });

      const run = yield* Runner.run(categorize);

      expect(run.variants[0]?.usage).toMatchObject({ calls: 3, inputTokens: 300 });
      expect(
        Option.getOrElse(run.variants[0]?.usage.costUsd ?? Option.none(), () => 0),
      ).toBeCloseTo(0.03);
    }),
  );

  it.effect("plans the task calls of every variant and trial", () =>
    Effect.gen(function* () {
      const categorize = Eval.makeBatched({
        dataset: Dataset.fromIterable([...movements, Dataset.skip("m4", "no ground truth")], byId),
        execution: Execution.batched(2),
        name: "categorizer",
        score: categoryScorer,
        task: (inputs) => Effect.succeed(inputs.map((input) => input.input.category)),
        trials: 3,
      });

      const plan = yield* Runner.plan(categorize, { variants: 2 });

      expect(plan).toEqual({
        batches: 2,
        cases: 3,
        invocations: 12,
        skipped: 1,
        trials: 3,
        variants: 2,
      });
    }),
  );
});

describe("Runner.rescore", () => {
  const definition = {
    dataset: Dataset.fromIterable(movements, byId),
    name: "categorizer",
    output: Schema.NullOr(Schema.String),
  };

  const lenient = Eval.make({
    ...definition,
    score: Scorer.label<Movement, string | null>({
      actual: (output) => Option.map(Option.fromNullishOr(output), (text) => text.toLowerCase()),
      expected: (movement) =>
        movement.category === null ? Scorer.absent : Scorer.present(movement.category),
    }),
    task: () => Effect.die("the task must not run"),
  });

  it.effect("scores the stored outputs of a run again without calling the task", () =>
    Effect.gen(function* () {
      const stored = yield* Runner.run(
        Eval.make({
          ...definition,
          score: categoryScorer,
          task: (input) => Effect.succeed(input.input.id === "m2" ? "FUEL" : input.input.category),
        }),
      );

      const rescored = yield* Runner.rescoreRun(lenient, stored);

      expect(counts(stored)?.["right"]).toBe(2);
      expect(counts(rescored)?.["right"]).toBe(3);
      expect(rescored.rescoreOf).toEqual(Option.some(stored.id));
    }),
  );

  it.effect("plans no task call, in the run and in what the terminal prints when it starts", () =>
    Effect.gen(function* () {
      const stored = yield* Runner.run(
        Eval.make({
          ...definition,
          score: categoryScorer,
          task: (input) => Effect.succeed(input.input.category),
        }),
      );

      const printed: string[] = [];

      const rescored = yield* Runner.rescoreRun(lenient, stored).pipe(
        Effect.provide(
          Reporter.layer([
            Reporters.terminal({
              color: false,
              write: (line) =>
                Effect.sync(() => {
                  printed.push(line);
                }),
            }),
          ]),
        ),
      );

      expect(rescored.plan.invocations).toBe(0);
      expect(printed[0]).toMatch(/, 0 task calls$/u);
    }),
  );

  it.effect("loads the run to score again from the history", () =>
    Effect.gen(function* () {
      const stored = yield* Runner.run(
        Eval.make({
          ...definition,
          score: categoryScorer,
          task: (input) => Effect.succeed(input.input.id === "m2" ? "FUEL" : input.input.category),
        }),
      ).pipe(Effect.provide(Reporter.layer([History.reporter])));

      const rescored = yield* Runner.rescore(lenient, { from: History.latest });

      expect(counts(rescored)?.["right"]).toBe(3);
      expect(rescored.rescoreOf).toEqual(Option.some(stored.id));
    }).pipe(Effect.provide(History.layerMemory)),
  );

  it.effect("errors a case whose input changed since the stored run", () =>
    Effect.gen(function* () {
      const stored = yield* Runner.run(
        Eval.make({
          ...definition,
          hash: (movement) => movement.text,
          score: categoryScorer,
          task: (input) => Effect.succeed(input.input.category),
        }),
      );

      const edited = Eval.make({
        ...definition,
        dataset: Dataset.fromIterable(
          movements.map((movement) =>
            movement.id === "m1" ? { ...movement, text: "AFFITTO MAGAZZINO" } : movement,
          ),
          byId,
        ),
        hash: (movement) => movement.text,
        score: categoryScorer,
        task: () => Effect.die("the task must not run"),
      });

      const rescored = yield* Runner.rescoreRun(edited, stored);

      expect(rescored.outputs.find((output) => output.case === "m1")?.failure).toEqual(
        Option.some("stale: the input changed since the stored run"),
      );
      expect(counts(rescored)).toMatchObject({ errored: 1, right: 2 });
    }),
  );

  it.effect("errors a case the stored run has no output for", () =>
    Effect.gen(function* () {
      const stored = yield* Runner.run(
        Eval.make({
          ...definition,
          dataset: Dataset.fromIterable(movements.slice(0, 2), byId),
          score: categoryScorer,
          task: (input) => Effect.succeed(input.input.category),
        }),
      );

      const rescored = yield* Runner.rescoreRun(lenient, stored);

      expect(rescored.outputs.find((output) => output.case === "m3")?.failure).toEqual(
        Option.some("missing: the stored run has no output for this case"),
      );
    }),
  );
});

describe("Runner.run with a sensitive dataset", () => {
  it.effect("treats a run over Dataset.optional as sensitive and redacts it", () =>
    Effect.gen(function* () {
      const events: EvalEvent[] = [];

      const real = Eval.make({
        dataset: Dataset.optional(Config.succeed("/private.json"), Schema.String, {
          id: (text) => text,
        }),
        name: "real",
        output: Schema.String,
        score: Scorer.label<string, string>({ actual: Option.some, expected: Scorer.present }),
        task: (input) =>
          input.input === "CUSTOMER_SECRET"
            ? Effect.succeed(input.input)
            : Effect.fail(`Invalid response for ${input.input}`),
      });

      const run = yield* Runner.run(real).pipe(
        Effect.provide(Reporter.layer([recording(events)])),
        Effect.provide(
          Layer.merge(
            FileSystem.layerNoop({
              readFileString: () => Effect.succeed('["CUSTOMER_SECRET","RSSMRA80A01H501U"]'),
            }),
            Path.layer,
          ),
        ),
      );

      expect(run.sensitive).toBe(true);
      expect(events.find(Events.isRunStarted)?.sensitive).toBe(true);
      expect(
        JSON.stringify(
          events.flatMap((event) => (Events.isCaseFinished(event) ? [event.output] : [])),
        ),
      ).not.toContain("CUSTOMER_SECRET");
      const errored = events.find(Events.isCaseErrored);
      expect(errored?.failure).toBe("[redacted]");
      expect(errored?.observations.map((observation) => observation.failure)).toEqual([
        Option.some("[redacted]"),
      ]);
    }),
  );
});

const fromFile = <S extends Schema.Codec<unknown, unknown>>(
  schema: S,
  show: (input: S["Type"]) => string,
) =>
  Eval.make({
    dataset: Dataset.json(schema, "cases.json", { id: () => "a" }),
    name: "decoded",
    output: Schema.String,
    score: Scorer.label<S["Type"], string>({
      actual: Option.some,
      expected: (input) => Scorer.present(show(input)),
    }),
    task: (input) => Effect.succeed(show(input.input)),
  });

const doubled = (factor: number) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.Number,
      SchemaTransformation.transform({
        decode: (text) => Number(text) * factor,
        encode: (value) => String(value / factor),
      }),
    ),
  );

const defaulted = (amount: number) =>
  Schema.Struct({
    amount: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(amount))),
  });

const casesFile = (text: string) =>
  Effect.provide(
    Layer.merge(FileSystem.layerNoop({ readFileString: () => Effect.succeed(text) }), Path.layer),
  );

const DAY_MILLIS = 86_400_000;

const shifted = (days: number) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.Date,
      SchemaTransformation.transform({
        decode: (text) => new Date(Date.parse(text) + days * DAY_MILLIS),
        encode: (date) => new Date(date.getTime() - days * DAY_MILLIS).toISOString(),
      }),
    ),
  );

const datedBy = (
  schema: ReturnType<typeof shifted>,
  hashing: { readonly hash?: (date: Date) => string } = {},
) =>
  Eval.make({
    ...hashing,
    dataset: Dataset.json(schema, "cases.json", { id: () => "a" }),
    name: "dated",
    output: Schema.String,
    score: Scorer.label<Date, string>({
      actual: Option.some,
      expected: (date) => Scorer.present(date.toISOString()),
    }),
    task: (input) => Effect.succeed(input.input.toISOString()),
  });

describe("Runner.rescoreRun input hashes", () => {
  const scoreText = Scorer.label<{ readonly id: string; readonly text: string }, string>({
    actual: Option.some,
    expected: () => Scorer.present("old"),
  });

  const textEval = (text: string) =>
    Eval.make({
      dataset: Dataset.fromIterable([{ id: "a", text }], { id: (entry) => entry.id }),
      name: "texts",
      output: Schema.String,
      score: scoreText,
      task: (input) => Effect.succeed(input.input.text),
    });

  it.effect("hashes an in-memory JSON input, so a changed input is stale", () =>
    Effect.gen(function* () {
      const stored = yield* Runner.run(textEval("old"));

      const unchanged = yield* Runner.rescoreRun(textEval("old"), stored);
      const changed = yield* Runner.rescoreRun(textEval("CHANGED"), stored);

      expect(counts(unchanged)).toMatchObject({ errored: 0, right: 1 });
      expect(changed.outputs.map((output) => output.failure)).toEqual([
        Option.some("stale: the input changed since the stored run"),
      ]);
    }),
  );

  it.effect("hashes the decoded file input, so a changed decoder or default makes it stale", () =>
    Effect.gen(function* () {
      const decoder = yield* Effect.gen(function* () {
        const stored = yield* Runner.run(fromFile(doubled(1), String));

        return yield* Runner.rescoreRun(fromFile(doubled(2), String), stored);
      }).pipe(casesFile('["1"]'));

      const fallback = yield* Effect.gen(function* () {
        const stored = yield* Runner.run(fromFile(defaulted(1), (input) => String(input.amount)));

        return yield* Runner.rescoreRun(
          fromFile(defaulted(2), (input) => String(input.amount)),
          stored,
        );
      }).pipe(casesFile('[{"id":"a"}]'));

      expect([decoder, fallback].map((run) => run.outputs.map((output) => output.failure))).toEqual(
        [
          [Option.some("stale: the input changed since the stored run")],
          [Option.some("stale: the input changed since the stored run")],
        ],
      );
    }),
  );

  it.effect("leaves a decoded input that is not JSON unhashed, so a changed decoder is stale", () =>
    Effect.gen(function* () {
      const file = casesFile('["2025-01-01T00:00:00.000Z"]');
      const stored = yield* Runner.run(datedBy(shifted(0))).pipe(file);
      const rescored = yield* Runner.rescoreRun(datedBy(shifted(1)), stored).pipe(file);

      expect(stored.outputs.map((output) => output.inputHash)).toEqual(["unhashed"]);
      expect(rescored.outputs.map((output) => output.failure)).toEqual([
        Option.some("stale: the input changed since the stored run"),
      ]);
    }),
  );

  it.effect("hashes a decoded input that is not JSON with the hash of the eval", () =>
    Effect.gen(function* () {
      const hashed = (days: number) =>
        datedBy(shifted(days), { hash: (date) => date.toISOString() });

      const file = casesFile('["2025-01-01T00:00:00.000Z"]');
      const stored = yield* Runner.run(hashed(0)).pipe(file);

      const same = yield* Runner.rescoreRun(hashed(0), stored).pipe(file);
      const moved = yield* Runner.rescoreRun(hashed(1), stored).pipe(file);

      expect(counts(same)).toMatchObject({ errored: 0, right: 1 });
      expect(moved.outputs.map((output) => output.failure)).toEqual([
        Option.some("stale: the input changed since the stored run"),
      ]);
    }),
  );

  it.effect("treats an input it cannot hash as stale", () =>
    Effect.gen(function* () {
      const mapEval = Eval.make({
        dataset: Dataset.fromIterable([new Map([["id", "a"]])], { id: () => "a" }),
        name: "maps",
        output: Schema.String,
        score: Scorer.label<ReadonlyMap<string, string>, string>({
          actual: Option.some,
          expected: () => Scorer.present("a"),
        }),
        task: () => Effect.succeed("a"),
      });

      const stored = yield* Runner.run(mapEval);

      const rescored = yield* Runner.rescoreRun(mapEval, stored);

      expect(rescored.outputs.map((output) => output.failure)).toEqual([
        Option.some("stale: the input changed since the stored run"),
      ]);
    }),
  );
});

describe("Runner.rescoreRun persisted outputs", () => {
  it.effect("keeps a null output through the JSON lines of the history", () =>
    Effect.gen(function* () {
      const events: EvalEvent[] = [];

      const abstaining = Eval.make({
        dataset: Dataset.fromIterable(movements.slice(2), byId),
        name: "categorizer",
        output: Schema.NullOr(Schema.String),
        score: categoryScorer,
        task: () => Effect.succeed(null),
      });

      yield* Runner.run(abstaining).pipe(Effect.provide(Reporter.layer([recording(events)])));

      const decoded = yield* pipe(
        events,
        Effect.forEach((event) => Events.encodeLine(event).pipe(Effect.flatMap(Events.decodeLine))),
      );

      const stored = yield* Run.fold(decoded);

      const rescored = yield* Runner.rescoreRun(abstaining, stored);

      expect(stored.outputs.map((output) => output.output)).toEqual([Option.some(null)]);
      expect(counts(rescored)).toMatchObject({ errored: 0, right: 1 });
    }),
  );
});

const judgeCalls: string[] = [];

const judgeAnswering = (
  json: string,
  provider: Pick<Parameters<typeof LanguageModel.make>[0], "codecTransformer"> = {},
) =>
  Variant.make(
    "fake-judge",
    Layer.effect(
      LanguageModel.LanguageModel,
      LanguageModel.make({
        ...provider,
        generateText: () =>
          Effect.sync(() => {
            judgeCalls.push("call");

            return [
              { text: json, type: "text" as const },
              {
                reason: "stop" as const,
                type: "finish" as const,
                usage: { inputTokens: { total: 50 }, outputTokens: { total: 10 } },
              },
            ];
          }),
        streamText: () => Stream.empty,
      }),
    ),
  );

const judgeModel = judgeAnswering('{"faithful":true}');

const faithful = <O>(
  prompt: string,
  model: Variant.Variant<LanguageModel.LanguageModel> = judgeModel,
  options: { readonly show?: (output: O) => string; readonly quote?: (output: O) => string } = {},
) =>
  Judge.make({
    agreement: (rubric: { readonly faithful: boolean }) =>
      rubric.faithful ? Agreement.exact : Agreement.different,
    model,
    name: "faithful",
    prompt: (input: Case<string>, output: O) =>
      `${prompt} ${input.input} ${options.quote?.(output) ?? ""}`,
    rubric: Schema.Struct({ faithful: Schema.Boolean }),
    ...whenDefined(options.show, (show) => ({ show })),
  });

const summaries = (
  prompt: string,
  model: Variant.Variant<LanguageModel.LanguageModel> = judgeModel,
) =>
  Eval.make({
    budget: { maxCalls: 2 },
    dataset: Dataset.fromIterable(["Canone di marzo", "Canone di aprile"], { id: (text) => text }),
    name: "summaries",
    output: Schema.String,
    score: faithful<string>(prompt, model, { quote: (output) => output }),
    task: (input) => Effect.succeed(input.input),
  });

const isoDate = (date: Date) => date.toISOString();

const dated = (show?: (output: Date) => string) =>
  Eval.make({
    dataset: Dataset.fromIterable(["Canone di marzo"], { id: (text) => text }),
    name: "dated",
    output: Schema.DateFromString,
    score: faithful<Date>(
      "Is the date right?",
      judgeModel,
      whenDefined(show, (given) => ({ show: given })),
    ),
    task: () => Effect.succeed(new globalThis.Date("2025-01-01T00:00:00.000Z")),
  });

const withStoredOutput = (run: Run.Run, output: string): Run.Run => ({
  ...run,
  outputs: run.outputs.map((stored) => ({ ...stored, output: Option.some(output) })),
});

describe("Runner.run usage of tracked and malformed judges", () => {
  it.effect("counts a judge call once when its model is already tracked", () =>
    Effect.gen(function* () {
      const tracked = Variant.make(
        "tracked-judge",
        Usage.trackLanguageModel.pipe(Layer.provide(judgeModel.layer)),
      );

      const run = yield* Runner.run(summaries("Is it faithful?", tracked));

      expect(run.variants[0]?.usage).toMatchObject({
        calls: 2,
        inputTokens: 100,
        outputTokens: 20,
      });
      expect(run.variants[0]?.usage.labels["judge:faithful"]).toMatchObject({
        calls: 2,
        inputTokens: 100,
      });
    }),
  );

  it.effect("keeps the tokens of a judge answer that does not match the rubric", () =>
    Effect.gen(function* () {
      const run = yield* Runner.run(
        summaries("Is it faithful?", judgeAnswering('{"faithful":"maybe"}')),
      );

      expect(counts(run)).toMatchObject({ errored: 2 });
      expect(run.variants[0]?.usage.labels["judge:faithful"]).toMatchObject({
        calls: 2,
        inputTokens: 100,
        outputTokens: 20,
      });
    }),
  );
});

describe("Runner.rescoreRun judge verdicts of outputs that are not JSON", () => {
  it.effect("asks the judge again when an output without show changed", () =>
    Effect.gen(function* () {
      const stored = yield* Runner.run(dated());
      const before = judgeCalls.length;

      yield* Runner.rescoreRun(dated(), withStoredOutput(stored, "2026-02-01T00:00:00.000Z"));

      expect(judgeCalls.length - before).toBe(1);
    }),
  );

  it.effect("reuses the verdict of an unchanged output that show describes", () =>
    Effect.gen(function* () {
      const stored = yield* Runner.run(dated(isoDate));
      const before = judgeCalls.length;

      yield* Runner.rescoreRun(dated(isoDate), stored);
      const afterSame = judgeCalls.length;
      yield* Runner.rescoreRun(
        dated(isoDate),
        withStoredOutput(stored, "2026-02-01T00:00:00.000Z"),
      );

      expect([afterSame - before, judgeCalls.length - afterSame]).toEqual([0, 1]);
    }),
  );
});

describe("Runner.run usage of scorers", () => {
  it.effect("counts the judge calls and tokens in the usage under judge:<name>", () =>
    Effect.gen(function* () {
      const run = yield* Runner.run(summaries("Is it faithful?"));

      expect(run.variants[0]?.usage).toMatchObject({
        calls: 2,
        inputTokens: 100,
        outputTokens: 20,
      });
      expect(run.variants[0]?.usage.labels["judge:faithful"]).toMatchObject({
        calls: 2,
        inputTokens: 100,
      });
      expect(counts(run)).toMatchObject({ errored: 0, right: 2 });
    }),
  );

  it.effect("keeps the usage a custom scorer records", () =>
    Effect.gen(function* () {
      const metered = Eval.make({
        dataset: Dataset.fromIterable(movements, byId),
        name: "categorizer",
        score: Scorer.make((input: Case<Movement>, outcome: Scorer.Outcome<string | null>) =>
          Usage.record({ inputTokens: 7 }).pipe(Effect.andThen(categoryScorer(input, outcome))),
        ),
        task: (input) => Effect.succeed(input.input.category),
      });

      const run = yield* Runner.run(metered);

      expect(run.variants[0]?.usage).toMatchObject({ calls: 3, inputTokens: 21 });
    }),
  );

  it.effect("reuses the stored verdict on rescore while the prompt and output are unchanged", () =>
    Effect.gen(function* () {
      const stored = yield* Runner.run(summaries("Is it faithful?"));
      const callsBefore = judgeCalls.length;

      const reused = yield* Runner.rescoreRun(summaries("Is it faithful?"), stored);
      const callsAfterReuse = judgeCalls.length;
      const asked = yield* Runner.rescoreRun(summaries("Is it a faithful summary?"), stored);

      expect(callsAfterReuse - callsBefore).toBe(0);
      expect(counts(reused)).toMatchObject({ right: 2 });
      expect(reused.variants[0]?.usage.calls).toBe(0);
      expect(judgeCalls.length - callsAfterReuse).toBe(2);
      expect(asked.variants[0]?.usage.labels["judge:faithful"]?.calls).toBe(2);
    }),
  );
});

const scoring = (maximum: number, model: Variant.Variant<LanguageModel.LanguageModel>) =>
  Eval.make({
    dataset: Dataset.fromIterable(["Canone di marzo"], { id: (text) => text }),
    name: "scored",
    output: Schema.String,
    score: Judge.make({
      agreement: (rubric: { readonly score: number }) =>
        rubric.score >= maximum * 0.8 ? Agreement.exact : Agreement.different,
      model,
      name: "score",
      prompt: (input: Case<string>, output: string) => `Score ${output} for ${input.input}`,
      rubric: Schema.Struct({
        score: Schema.Number.check(Schema.isBetween({ maximum, minimum: 0 })),
      }),
    }),
    task: (input) => Effect.succeed(input.input),
  });

const defaulting = (
  fallback: number,
  options: {
    readonly transform?: {
      readonly decode: (score: number) => number;
      readonly encode: (score: number) => number;
    };
    readonly version?: string;
  } = {},
) =>
  Eval.make({
    dataset: Dataset.fromIterable(["Canone di marzo"], { id: (text) => text }),
    gates: [Gate.max(Metric.wrong, 0)],
    name: "defaulted",
    output: Schema.String,
    score: Judge.make({
      agreement: (rubric: { readonly score: number }) =>
        rubric.score === 2 ? Agreement.exact : Agreement.different,
      model: judgeAnswering("{}"),
      name: "defaulted",
      prompt: (input: Case<string>, output: string) => `Score ${output} for ${input.input}`,
      rubric: Schema.Struct({
        score: (options.transform === undefined
          ? Schema.Number
          : Schema.Number.pipe(
              Schema.decodeTo(Schema.Number, SchemaTransformation.transform(options.transform)),
            )
        ).pipe(Schema.withDecodingDefaultKey(Effect.succeed(fallback))),
      }),
      ...whenDefined(options.version, (version) => ({ version })),
    }),
    task: (input) => Effect.succeed(input.input),
  });

const archived = <E, R>(running: Effect.Effect<Run.Run, E, R>) =>
  Effect.gen(function* () {
    const events: EvalEvent[] = [];
    yield* running.pipe(Effect.provide(Reporter.layer([recording(events)])));

    const lines = yield* pipe(
      events,
      Effect.forEach((event) => Events.encodeLine(event).pipe(Effect.flatMap(Events.decodeLine))),
    );

    return yield* Run.fold(lines);
  });

const persisted = <A, O>(self: Eval.Eval<A, O>) => archived(Runner.run(self));

const openAiJudged = <Rubric extends { readonly [key: string]: unknown }>(
  answer: string,
  rubric: Schema.Codec<Rubric, { readonly [key: string]: Schema.Json }>,
  right: (verdict: Rubric) => boolean,
  version?: string,
) =>
  Eval.make({
    dataset: Dataset.fromIterable(["Canone di marzo"], { id: (text) => text }),
    gates: [Gate.max(Metric.wrong, 0)],
    name: "openai-judged",
    output: Schema.String,
    score: Judge.make({
      agreement: (verdict: Rubric) => (right(verdict) ? Agreement.exact : Agreement.different),
      model: judgeAnswering(answer, { codecTransformer: OpenAiStructuredOutput.toCodecOpenAI }),
      name: "openai",
      prompt: (input: Case<string>, output: string) => `Judge ${output} for ${input.input}`,
      rubric,
      ...whenDefined(version, (given) => ({ version: given })),
    }),
    task: (input) => Effect.succeed(input.input),
  });

const verdictsOf = (run: Run.Run) =>
  run.variants[0]?.observations.map((scored) => [
    scored.observation.key,
    Verdicts.of(scored.observation),
  ]);

const outcomeOf = (run: Run.Run) => ({
  accuracy: run.variants[0]?.summary.ratios["accuracy"]?.value,
  passed: run.passed,
  verdicts: verdictsOf(run),
});

const nullableScore = Schema.Struct({ score: Schema.optionalKey(Schema.NullOr(Schema.Number)) });

describe("Runner.rescoreRun judge results the observation codec cannot keep", () => {
  it.effect("asks the judge again for a result that does not round-trip", () =>
    Effect.gen(function* () {
      const judged = openAiJudged('{"score":1}', nullableScore, () => true);

      const unkept = Eval.make({
        dataset: Dataset.fromIterable(["Canone di marzo"], { id: (text) => text }),
        name: "unkept",
        output: Schema.String,
        score: Judge.make({
          agreement: () => Agreement.partial(Number.NaN),
          model: judgeAnswering('{"score":1}'),
          name: "unkept",
          prompt: (input: Case<string>) => `Judge ${input.input}`,
          rubric: nullableScore,
        }),
        task: (input) => Effect.succeed(input.input),
      });

      const keptRun = yield* persisted(judged);
      const unkeptRun = yield* persisted(unkept);
      const before = judgeCalls.length;

      yield* Runner.rescoreRun(judged, keptRun);
      const kept = judgeCalls.length - before;
      yield* Runner.rescoreRun(unkept, unkeptRun);

      expect([kept, judgeCalls.length - before - kept]).toEqual([0, 1]);
      expect(unkeptRun.outputs.map((output) => output.judgements)).toEqual([[]]);
    }),
  );

  it.effect("keeps the stored result when only the agreement changed", () =>
    Effect.gen(function* () {
      const stored = yield* persisted(openAiJudged('{"score":1}', nullableScore, () => true));
      const before = judgeCalls.length;

      const rescored = yield* Runner.rescoreRun(
        openAiJudged('{"score":1}', nullableScore, () => false),
        stored,
      );

      expect(judgeCalls.length - before).toBe(0);
      expect(outcomeOf(rescored)).toEqual(outcomeOf(stored));
    }),
  );
});

describe("Runner.rescoreRun judge results under a provider codec", () => {
  it.effect("reuses the result of a nullable optional answer as it was", () =>
    Effect.gen(function* () {
      const judged = openAiJudged(
        '{"score":null}',
        nullableScore,
        (verdict) => verdict.score === undefined,
      );

      const stored = yield* persisted(judged);
      const before = judgeCalls.length;

      const rescored = yield* Runner.rescoreRun(judged, stored);

      expect(judgeCalls.length - before).toBe(0);
      expect(outcomeOf(rescored)).toEqual(outcomeOf(stored));
      expect(counts(stored)).toMatchObject({ right: 1 });
    }),
  );

  it.effect("reuses the result of a non-nullable optional answer as it was", () =>
    Effect.gen(function* () {
      const judged = openAiJudged(
        '{"note":null,"score":2}',
        Schema.Struct({ note: Schema.optionalKey(Schema.String), score: Schema.Number }),
        (verdict) => verdict.score === 2 && verdict.note === undefined,
      );

      const stored = yield* persisted(judged);
      const before = judgeCalls.length;

      const rescored = yield* Runner.rescoreRun(judged, stored);

      expect(judgeCalls.length - before).toBe(0);
      expect(outcomeOf(rescored)).toEqual(outcomeOf(stored));
      expect(counts(stored)).toMatchObject({ right: 1 });
    }),
  );

  it.effect(
    "asks again for a rubric whose encoder drops a null score, unless it has a version",
    () =>
      Effect.gen(function* () {
        const dropping = (version?: string) =>
          openAiJudged(
            '{"score":null}',
            nullableScore.pipe(
              Schema.decodeTo(
                nullableScore,
                SchemaTransformation.transform({
                  decode: (value) => value,
                  encode: (value) =>
                    value.score === null || value.score === undefined ? {} : value,
                }),
              ),
            ),
            (verdict) => verdict.score === undefined,
            version,
          );

        const stored = yield* persisted(dropping());
        const versioned = yield* persisted(dropping("1"));
        const before = judgeCalls.length;

        const rescored = yield* Runner.rescoreRun(dropping(), stored);
        const unversionedCalls = judgeCalls.length - before;
        const reused = yield* Runner.rescoreRun(dropping("1"), versioned);

        expect([unversionedCalls, judgeCalls.length - before - unversionedCalls]).toEqual([1, 0]);
        expect([outcomeOf(rescored), outcomeOf(reused)]).toEqual([
          outcomeOf(stored),
          outcomeOf(versioned),
        ]);
        expect(outcomeOf(stored)).toMatchObject({ accuracy: Option.some(1), passed: true });
      }),
  );

  it.effect(
    "keeps a failed eval failed on rescore, when the rubric encoder forgets every score",
    () =>
      Effect.gen(function* () {
        const judged = openAiJudged(
          '{"score":null}',
          nullableScore.pipe(
            Schema.decodeTo(
              nullableScore,
              SchemaTransformation.transform({ decode: (value) => value, encode: () => ({}) }),
            ),
          ),
          (verdict) => verdict.score === null,
        );

        const stored = yield* persisted(judged);
        const before = judgeCalls.length;

        const rescored = yield* Runner.rescoreRun(judged, stored);

        expect(judgeCalls.length - before).toBe(1);
        expect(outcomeOf(rescored)).toEqual(outcomeOf(stored));
        expect(outcomeOf(stored)).toMatchObject({ passed: false });
        expect(counts(stored)).toMatchObject({ wrong: 1 });
      }),
  );
});

const okJudge = <O>(asked: string[], show: (output: O) => string) =>
  Judge.make({
    agreement: (verdict: { readonly ok: boolean }) =>
      verdict.ok ? Agreement.exact : Agreement.different,
    model: Variant.make(
      "turn-judge",
      Layer.effect(
        LanguageModel.LanguageModel,
        LanguageModel.make({
          generateText: () =>
            Effect.sync(() => {
              const answer = asked.length === 0 ? '{"ok":true}' : '{"ok":false}';
              asked.push(answer);

              return [
                { text: answer, type: "text" as const },
                {
                  reason: "stop" as const,
                  type: "finish" as const,
                  usage: { inputTokens: { total: 5 }, outputTokens: { total: 1 } },
                },
              ];
            }),
          streamText: () => Stream.empty,
        }),
      ),
    ),
    name: "ok",
    prompt: () => "judge",
    rubric: Schema.Struct({ ok: Schema.Boolean }),
    show,
  });

const rescoredTwice = <A, O>(self: Eval.Eval<A, O>) =>
  Effect.gen(function* () {
    const first = yield* persisted(self);
    const second = yield* archived(Runner.rescoreRun(self, first));
    const third = yield* archived(Runner.rescoreRun(self, second));

    return [first, second, third] as const;
  });

const judgementsOf = (run: Run.Run) =>
  run.outputs.flatMap((output) => output.judgements.map((judgement) => judgement.key));

describe("Runner.rescoreRun of a rescore", () => {
  it.effect("keeps the reused judge result in the rescore, so the next one reuses it too", () =>
    Effect.gen(function* () {
      const asked: string[] = [];

      const self = Eval.make({
        dataset: Dataset.fromIterable(["case"], { id: (id: string) => id }),
        gates: [Gate.max(Metric.wrong, 0)],
        name: "chained",
        output: Schema.String,
        score: okJudge(asked, (output: string) => output),
        task: () => Effect.succeed("output"),
      });

      const runs = yield* rescoredTwice(self);
      const [first] = runs;

      expect(asked).toEqual(['{"ok":true}']);
      expect(runs.map(judgementsOf)).toEqual([["judge:ok"], ["judge:ok"], ["judge:ok"]]);
      expect(runs.map(outcomeOf)).toEqual([outcomeOf(first), outcomeOf(first), outcomeOf(first)]);
      expect(outcomeOf(first)).toMatchObject({ passed: true });
    }),
  );

  it.effect("keeps the reused results of a judge under Scorer.each", () =>
    Effect.gen(function* () {
      const asked: string[] = [];

      const self = Eval.make({
        dataset: Dataset.fromIterable(["page"], { id: (id: string) => id }),
        gates: [Gate.max(Metric.wrong, 0)],
        name: "chained-each",
        output: Schema.String,
        score: Scorer.each(
          {
            actual: (output: string) =>
              new Map([
                ["a", output],
                ["b", output],
              ]),
            expected: () => [
              { id: "a", input: "a", tags: [] },
              { id: "b", input: "b", tags: [] },
            ],
          },
          okJudge(asked, (output: Option.Option<string>) => Option.getOrElse(output, () => "")),
        ),
        task: () => Effect.succeed("output"),
      });

      const runs = yield* rescoredTwice(self);
      const [first] = runs;

      expect(asked).toEqual(['{"ok":true}', '{"ok":false}']);
      expect(runs.map(judgementsOf)).toEqual([
        ["a/judge:ok", "b/judge:ok"],
        ["a/judge:ok", "b/judge:ok"],
        ["a/judge:ok", "b/judge:ok"],
      ]);
      expect(runs.map(outcomeOf)).toEqual([outcomeOf(first), outcomeOf(first), outcomeOf(first)]);
      expect(outcomeOf(first)).toMatchObject({ passed: false });
    }),
  );
});

describe("Runner.rescoreRun judge verdicts of sub-cases", () => {
  it.effect("keeps the verdict of each sub-case, when two ask the same question", () =>
    Effect.gen(function* () {
      const answers = ['{"score":1}', '{"score":0}'];
      const asked: string[] = [];

      const quality = Variant.make(
        "quality-judge",
        Layer.effect(
          LanguageModel.LanguageModel,
          LanguageModel.make({
            generateText: () =>
              Effect.sync(() => {
                const answer = answers[asked.length] ?? '{"score":1}';
                asked.push(answer);

                return [
                  { text: answer, type: "text" as const },
                  {
                    reason: "stop" as const,
                    type: "finish" as const,
                    usage: { inputTokens: { total: 5 }, outputTokens: { total: 1 } },
                  },
                ];
              }),
            streamText: () => Stream.empty,
          }),
        ),
      );

      const nested = Eval.make({
        dataset: Dataset.fromIterable(["page"], { id: (id: string) => id }),
        name: "nested-judge",
        output: Schema.Struct({ a: Schema.String, b: Schema.String }),
        score: Scorer.each(
          {
            actual: (output: { readonly a: string; readonly b: string }) =>
              new Map([
                ["a", output.a],
                ["b", output.b],
              ]),
            expected: () => [
              { id: "a", input: "a", tags: [] },
              { id: "b", input: "b", tags: [] },
            ],
          },
          Judge.make({
            agreement: (verdict: { readonly score: number }) =>
              verdict.score === 1 ? Agreement.exact : Agreement.different,
            model: quality,
            name: "quality",
            prompt: () => "Is it good?",
            rubric: Schema.Struct({ score: Schema.Number }),
            show: () => "same",
          }),
        ),
        task: () => Effect.succeed({ a: "same", b: "same" }),
      });

      const stored = yield* persisted(nested);
      const rescored = yield* Runner.rescoreRun(nested, stored);

      expect(verdictsOf(stored)).toEqual([
        ["a/judge:quality", Verdicts.verdicts.right],
        ["b/judge:quality", Verdicts.verdicts.wrong],
      ]);
      expect(outcomeOf(rescored)).toEqual(outcomeOf(stored));
      expect(
        stored.outputs.flatMap((output) => output.judgements.map((judgement) => judgement.key)),
      ).toEqual(["a/judge:quality", "b/judge:quality"]);
      expect(asked).toEqual(['{"score":1}', '{"score":0}']);
    }),
  );
});

describe("Runner.rescoreRun judge verdicts of another rubric or model", () => {
  it.effect("asks the judge again when a default of the rubric changed", () =>
    Effect.gen(function* () {
      const stored = yield* Runner.run(defaulting(1));
      const before = judgeCalls.length;

      const same = yield* Runner.rescoreRun(defaulting(1), stored);
      const afterSame = judgeCalls.length;
      const changed = yield* Runner.rescoreRun(defaulting(2), stored);

      expect([afterSame - before, judgeCalls.length - afterSame]).toEqual([0, 1]);
      expect([counts(stored), counts(same), counts(changed)]).toMatchObject([
        { wrong: 1 },
        { wrong: 1 },
        { right: 1 },
      ]);
    }),
  );

  it.effect("reuses the result of a rubric with a transform it cannot invert, by its version", () =>
    Effect.gen(function* () {
      const offByOne = defaulting(1, {
        transform: { decode: (score) => score + 1, encode: (score) => score },
        version: "1",
      });

      const stored = yield* persisted(offByOne);
      const before = judgeCalls.length;

      const rescored = yield* Runner.rescoreRun(offByOne, stored);

      expect(judgeCalls.length - before).toBe(0);
      expect(outcomeOf(rescored)).toEqual(outcomeOf(stored));
      expect(counts(stored)).toMatchObject({ right: 1 });
    }),
  );

  it.effect("asks the judge again when a lossy encoder hides a changed default", () =>
    Effect.gen(function* () {
      const lossy = { decode: (score: number) => score, encode: () => 0 };
      const stored = yield* persisted(defaulting(2, { transform: lossy }));
      const before = judgeCalls.length;

      const rescored = yield* Runner.rescoreRun(defaulting(1, { transform: lossy }), stored);

      expect(judgeCalls.length - before).toBe(1);
      expect([outcomeOf(stored), outcomeOf(rescored)]).toMatchObject([
        { accuracy: Option.some(1), passed: true },
        { accuracy: Option.some(0), passed: false },
      ]);
    }),
  );

  it.effect("reuses a rubric with transforms until its version changes", () =>
    Effect.gen(function* () {
      const lossy = { decode: (score: number) => score, encode: () => 0 };
      const stored = yield* persisted(defaulting(2, { transform: lossy, version: "1" }));
      const before = judgeCalls.length;

      const same = yield* Runner.rescoreRun(
        defaulting(1, { transform: lossy, version: "1" }),
        stored,
      );

      const afterSame = judgeCalls.length;

      const bumped = yield* Runner.rescoreRun(
        defaulting(1, { transform: lossy, version: "2" }),
        stored,
      );

      expect([afterSame - before, judgeCalls.length - afterSame]).toEqual([0, 1]);
      expect([outcomeOf(same), outcomeOf(bumped)]).toMatchObject([
        { passed: true },
        { accuracy: Option.some(0), passed: false },
      ]);
    }),
  );
  it.effect("asks the judge again when the rubric changed", () =>
    Effect.gen(function* () {
      const stored = yield* Runner.run(scoring(1, judgeAnswering('{"score":1}')));
      const before = judgeCalls.length;

      const rescored = yield* Runner.rescoreRun(
        scoring(10, judgeAnswering('{"score":10}')),
        stored,
      );

      expect(judgeCalls.length - before).toBe(1);
      expect(counts(rescored)).toMatchObject({ right: 1 });
    }),
  );

  it.effect("asks the judge again when the judge model changed", () =>
    Effect.gen(function* () {
      const stored = yield* Runner.run(scoring(1, judgeAnswering('{"score":1}')));
      const before = judgeCalls.length;

      yield* Runner.rescoreRun(
        scoring(1, Variant.make("other-judge", judgeAnswering('{"score":1}').layer)),
        stored,
      );

      expect(judgeCalls.length - before).toBe(1);
    }),
  );
});

describe("Runner.run trials", () => {
  it.effect("refuses a trial count that is not a positive integer before calling the task", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      const categorize = (trials: number) =>
        Eval.make({
          dataset: Dataset.fromIterable(movements, byId),
          name: "categorizer",
          score: categoryScorer,
          setup: Effect.sync(() => calls.push("setup")),
          task: (input) =>
            Effect.sync(() => calls.push(input.id)).pipe(Effect.as(input.input.category)),
          trials,
        });

      const zero = yield* Effect.flip(Runner.run(categorize(0)));
      const fraction = yield* Effect.flip(Runner.run(categorize(1), { trials: 1.5 }));
      const planned = yield* Effect.flip(Runner.plan(categorize(1), { trials: -1 }));

      expect(
        [zero, fraction, planned].map((failure) => failure instanceof EvalConfigError),
      ).toEqual([true, true, true]);
      expect(calls).toEqual([]);
    }),
  );
});

describe("Runner.run terminal events", () => {
  it.effect("ends the run with RunFinished when a variant layer fails and keeps the failure", () =>
    Effect.gen(function* () {
      const events: EvalEvent[] = [];

      const categorize = Eval.make({
        dataset: Dataset.fromIterable(movements, byId),
        name: "categorizer",
        score: categoryScorer,
        task: (input) => Effect.succeed(input.input.category),
      });

      const failure = yield* Effect.flip(
        Runner.run(categorize, {
          variants: [Variant.make("broken", Layer.effectDiscard(Effect.fail("no API key")))],
        }).pipe(Effect.provide(Reporter.layer([recording(events)]))),
      );

      expect(failure).toBe("no API key");
      expect(events.filter(Events.isRunFinished)).toMatchObject([{ passed: false }]);
    }),
  );

  it.effect("ends the run with RunFinished when a variant layer dies", () =>
    Effect.gen(function* () {
      const events: EvalEvent[] = [];

      const categorize = Eval.make({
        dataset: Dataset.fromIterable(movements, byId),
        name: "categorizer",
        score: categoryScorer,
        task: (input) => Effect.succeed(input.input.category),
      });

      const exit = yield* Effect.exit(
        Runner.run(categorize, {
          variants: [Variant.make("broken", Layer.effectDiscard(Effect.die("boom")))],
        }).pipe(Effect.provide(Reporter.layer([recording(events)]))),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(events.filter(Events.isRunFinished)).toHaveLength(1);
    }),
  );

  it.effect("writes the failed reporters in RunFinished, so the history keeps them", () =>
    Effect.gen(function* () {
      const events: EvalEvent[] = [];

      const categorize = Eval.make({
        dataset: Dataset.fromIterable(movements, byId),
        name: "categorizer",
        score: categoryScorer,
        task: (input) => Effect.succeed(input.input.category),
      });

      const run = yield* Runner.run(categorize).pipe(
        Effect.provide(
          Reporter.layer([
            Reporter.fromStream("broken", () => Effect.fail("disk full")),
            recording(events),
          ]),
        ),
      );

      const folded = yield* Run.fold(events);

      expect(run.failedReporters).toEqual(["broken"]);
      expect(folded.failedReporters).toEqual(["broken"]);
    }),
  );
});

class Categorizer extends Context.Service<Categorizer, (text: string) => string | null>()(
  "tests/Categorizer",
) {}

describe("Runner types with services that have no default", () => {
  const categorize = Eval.make({
    dataset: Dataset.fromIterable(movements, byId),
    name: "categorizer",
    output: Schema.NullOr(Schema.String),
    score: categoryScorer,
    task: (input) =>
      Effect.service(Categorizer).pipe(Effect.map((categorizer) => categorizer(input.input.text))),
  });

  const keywords = Variant.make(
    "keywords",
    Layer.succeed(
      Categorizer,
      (text: string): string | null =>
        movements.find((movement) => movement.text === text)?.category ?? null,
    ),
  );

  it.effect("lets the variant layer provide the services of the task", () =>
    Effect.gen(function* () {
      const run: Effect.Effect<Run.Run, unknown> = Runner.run(categorize, { variants: [keywords] });

      expect(counts(yield* run)?.["right"]).toBe(3);
    }),
  );

  it.effect("rescores without the services of the task", () =>
    Effect.gen(function* () {
      const stored = yield* Runner.run(categorize, { variants: [keywords] });

      const rescored: Effect.Effect<Run.Run, unknown> = Runner.rescoreRun(categorize, stored);

      expect(counts(yield* rescored)?.["right"]).toBe(3);
    }),
  );
});

const textScorer = Scorer.label<unknown, string>({
  actual: Option.some,
  expected: () => Scorer.present("x"),
});

const plain = (task: () => Effect.Effect<string, string>) =>
  Eval.make({
    dataset: Dataset.fromIterable(["a", "b"], { id: (id) => id }),
    name: "plain",
    output: Schema.String,
    score: textScorer,
    task,
  });

const sameVariants = [Variant.make("same", Layer.empty), Variant.make("same", Layer.empty)];

describe("Runner.run variant selection", () => {
  it.effect("refuses two variants with the same name before calling the task", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      const failure = yield* Effect.flip(
        Runner.run(
          plain(() => Effect.sync(() => calls.push("call")).pipe(Effect.as("x"))),
          { variants: sameVariants },
        ),
      );

      expect([failure, calls]).toEqual([expect.any(EvalConfigError), []]);
      expect(failure.message).toContain("same");
    }),
  );

  it.effect("refuses an empty list of variants", () =>
    Effect.gen(function* () {
      const noVariants: readonly Variant.Variant<never>[] = [];

      const failure = yield* Effect.flip(
        Runner.run(
          plain(() => Effect.succeed("x")),
          { variants: noVariants },
        ),
      );

      expect(failure).toBeInstanceOf(EvalConfigError);
    }),
  );

  it.effect("refuses to rescore a variant the stored run does not have, or none", () =>
    Effect.gen(function* () {
      const stored = yield* Runner.run(plain(() => Effect.succeed("x")));

      const typo = yield* Effect.flip(
        Runner.rescoreRun(
          plain(() => Effect.succeed("x")),
          stored,
          { variants: ["TYPO"] },
        ),
      );

      const none = yield* Effect.flip(
        Runner.rescoreRun(
          plain(() => Effect.succeed("x")),
          stored,
          { variants: [] },
        ),
      );

      expect([typo, none]).toEqual([expect.any(EvalConfigError), expect.any(EvalConfigError)]);
      expect(typo.message).toContain("TYPO");
    }),
  );
});

describe("Runner.rescoreRun sensitivity", () => {
  it.effect("keeps a sensitive stored run sensitive, whatever the eval says now", () =>
    Effect.gen(function* () {
      const events: EvalEvent[] = [];

      const secret = (sensitive: boolean) =>
        Eval.make({
          dataset: Dataset.fromIterable(["a"], { id: (id) => id }),
          name: "secret",
          output: Schema.String,
          score: textScorer,
          sensitive,
          task: () => Effect.succeed("CUSTOMER_SECRET"),
        });

      const stored = yield* Runner.run(secret(true));

      const rescored = yield* Runner.rescoreRun(secret(false), stored).pipe(
        Effect.provide(Reporter.layer([recording(events)])),
      );

      expect(rescored.sensitive).toBe(true);
      expect(JSON.stringify(events.filter(Events.isCaseFinished))).not.toContain("CUSTOMER_SECRET");
    }),
  );
});

describe("Runner.run containment", () => {
  it.effect("errors the cases of a batch whose task throws while it builds its effect", () =>
    Effect.gen(function* () {
      const crashing = Eval.makeBatched({
        dataset: Dataset.fromIterable(["a", "b"], { id: (id) => id }),
        execution: Execution.batched(2),
        name: "crashing",
        score: textScorer,
        task: (): Effect.Effect<readonly string[]> => {
          throw new Error("parser crashed");
        },
      });

      const run = yield* Runner.run(crashing);

      expect(counts(run)).toMatchObject({ errored: 2 });
    }),
  );

  it.effect("ends the run as interrupted when the setup is interrupted", () =>
    Effect.gen(function* () {
      const events: EvalEvent[] = [];

      const interrupted = Eval.make({
        dataset: Dataset.fromIterable(["a", "b"], { id: (id) => id }),
        name: "interrupted",
        score: textScorer,
        setup: Effect.interrupt,
        task: () => Effect.succeed("x"),
      });

      const exit = yield* Effect.exit(
        Runner.run(interrupted).pipe(Effect.provide(Reporter.layer([recording(events)]))),
      );

      expect(Exit.hasInterrupts(exit)).toBe(true);
      expect(
        events.flatMap((event) => (Events.isRunFinished(event) ? [event.interrupted] : [])),
      ).toEqual([true]);
    }),
  );

  it.effect(
    "ends the run as interrupted when a task or setup is interrupted and its cleanup dies",
    () =>
      Effect.gen(function* () {
        const interruptedDying = Effect.interrupt.pipe(
          Effect.ensuring(Effect.die("cleanup failed")),
        );

        const withTask = Eval.make({
          dataset: Dataset.fromIterable(["a"], { id: (id) => id }),
          name: "task",
          score: textScorer,
          task: () => interruptedDying,
        });

        const withSetup = Eval.make({
          dataset: Dataset.fromIterable(["a"], { id: (id) => id }),
          name: "setup",
          score: textScorer,
          setup: interruptedDying,
          task: () => Effect.succeed("x"),
        });

        const outcomes = yield* pipe(
          [withTask, withSetup],
          Effect.forEach((self) =>
            Effect.gen(function* () {
              const events: EvalEvent[] = [];

              const exit = yield* Effect.exit(
                Runner.run(self).pipe(Effect.provide(Reporter.layer([recording(events)]))),
              );

              return [
                Exit.hasInterrupts(exit),
                events.flatMap((event) => (Events.isRunFinished(event) ? [event.interrupted] : [])),
              ];
            }),
          ),
        );

        expect(outcomes).toEqual([
          [true, [true]],
          [true, [true]],
        ]);
      }),
  );

  it.effect(
    "ends the run as interrupted when the judge is interrupted, with or without a dying cleanup",
    () =>
      Effect.gen(function* () {
        const judgedBy = (generated: Effect.Effect<never>) =>
          summaries(
            "Is it faithful?",
            Variant.make(
              "interrupting-judge",
              Layer.effect(
                LanguageModel.LanguageModel,
                LanguageModel.make({
                  generateText: () => generated,
                  streamText: () => Stream.empty,
                }),
              ),
            ),
          );

        const outcomes = yield* pipe(
          [Effect.interrupt, Effect.interrupt.pipe(Effect.ensuring(Effect.die("cleanup failed")))],
          Effect.forEach((generated) =>
            Effect.gen(function* () {
              const events: EvalEvent[] = [];

              const exit = yield* Effect.exit(
                Runner.run(judgedBy(generated)).pipe(
                  Effect.provide(Reporter.layer([recording(events)])),
                ),
              );

              return [
                Exit.hasInterrupts(exit),
                events.flatMap((event) => (Events.isRunFinished(event) ? [event.interrupted] : [])),
                events.filter(Events.isCaseFinished).length,
              ];
            }),
          ),
        );

        expect(outcomes).toEqual([
          [true, [true], 0],
          [true, [true], 0],
        ]);
      }),
  );
});

describe("Runner.run outputs it cannot encode", () => {
  const short = Eval.make({
    dataset: Dataset.fromIterable(["a"], { id: (id) => id }),
    name: "short",
    output: Schema.String.check(Schema.isMinLength(3)),
    score: textScorer,
    task: () => Effect.succeed("b"),
  });

  it.effect("keeps a sensitive output out of the logs when it cannot encode it", () =>
    Effect.gen(function* () {
      const logged: string[] = [];
      const reported: EvalEvent[] = [];

      const secret = Eval.make({
        dataset: Dataset.fromIterable(["a"], { id: (id) => id }),
        name: "secret",
        output: Schema.String.check(
          Schema.makeFilter(
            (value: string): true | string => value === "public" || `Invalid value ${value}`,
          ),
        ),
        score: textScorer,
        sensitive: true,
        task: () => Effect.succeed("CUSTOMER-SECRET-123"),
      });

      const run = yield* Runner.run(secret).pipe(
        Effect.provide(Reporter.layer([recording(reported)])),
        Effect.provide(
          Logger.layer([
            Logger.make((options) => {
              logged.push(String(options.message));
            }),
          ]),
        ),
      );

      expect(logged.join("\n")).toContain("The output of a was not stored");
      expect(logged.join("\n")).not.toContain("CUSTOMER-SECRET-123");
      expect(JSON.stringify(reported)).not.toContain("CUSTOMER-SECRET-123");
      expect(run.outputs.map((output) => Option.getOrElse(output.outputError, () => ""))).toEqual([
        expect.stringContaining("Invalid value CUSTOMER-SECRET-123"),
      ]);
    }),
  );

  it.effect("records why the output was not stored, and rescore errors with it", () =>
    Effect.gen(function* () {
      const run = yield* Runner.run(short);

      const rescored = yield* Runner.rescoreRun(short, run);

      expect(run.outputs.map((output) => Option.isSome(output.outputError))).toEqual([true]);
      expect(
        rescored.variants[0]?.observations.map((scored) =>
          Option.getOrElse(scored.observation.failure, () => ""),
        ),
      ).toEqual([expect.stringMatching(/^unencodable: /u)]);
    }),
  );
});

const withoutTelemetry = <
  F extends (options: never) => Effect.Effect<{ readonly usage: Response.Usage }, unknown, unknown>,
>(
  generate: F,
): F => {
  const wrapped = (options: never) =>
    generate(options).pipe(Effect.provideService(Telemetry.CurrentSpanTransformer, () => {}));

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: wrapped takes the options of generate and returns its response unchanged; it only keeps the telemetry transformer from being called, as a provider that builds its own responses may.
  return wrapped as F;
};

const readyMade = (text: string) =>
  Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () =>
        Effect.succeed([
          { text, type: "text" as const },
          {
            reason: "stop" as const,
            type: "finish" as const,
            usage: { inputTokens: { total: 120 }, outputTokens: { reasoning: 4, total: 9 } },
          },
        ]),
      streamText: () => Stream.empty,
    }).pipe(
      Effect.map((base): LanguageModel.LanguageModel => ({
        ...base,
        generateObject: withoutTelemetry(base.generateObject),
        generateText: withoutTelemetry(base.generateText),
      })),
    ),
  );

const readyJudged = (model: Layer.Layer<LanguageModel.LanguageModel>) =>
  Eval.make({
    dataset: Dataset.fromIterable(["a"], { id: (id) => id }),
    name: "ready-judge",
    output: Schema.String,
    score: Judge.make({
      agreement: (verdict: { readonly score: number }) =>
        verdict.score === 1 ? Agreement.exact : Agreement.different,
      model: Variant.make("ready", model),
      name: "quality",
      prompt: (input: Case<string>) => `Judge ${input.input}`,
      rubric: Schema.Struct({ score: Schema.Number }),
    }),
    task: (input) => Effect.succeed(input.input),
  });

describe("Runner.run usage of a response its model built", () => {
  const answered = { calls: 1, inputTokens: 120, outputTokens: 9, reasoningTokens: 4 };

  it.effect("counts the tokens of the response once, when the model calls no telemetry", () =>
    Effect.gen(function* () {
      const run = yield* Runner.run(
        Eval.make({
          dataset: Dataset.fromIterable(["a"], { id: (id) => id }),
          name: "ready-made",
          score: textScorer,
          task: () =>
            LanguageModel.generateText({ prompt: "Categorize" }).pipe(
              Effect.map((response) => response.text),
              Effect.provide(Usage.trackLanguageModel.pipe(Layer.provide(readyMade("x")))),
            ),
        }),
      );

      expect(run.variants[0]?.usage).toMatchObject(answered);
    }),
  );

  it.effect("counts the tokens of a judge's response once, tracked or not", () =>
    Effect.gen(function* () {
      const untracked = yield* Runner.run(readyJudged(readyMade('{"score":1}')));

      const tracked = yield* Runner.run(
        readyJudged(Usage.trackLanguageModel.pipe(Layer.provide(readyMade('{"score":1}')))),
      );

      expect([
        untracked.variants[0]?.usage.labels["judge:quality"],
        tracked.variants[0]?.usage.labels["judge:quality"],
      ]).toMatchObject([answered, answered]);
      expect([counts(untracked)?.["right"], counts(tracked)?.["right"]]).toEqual([1, 1]);
    }),
  );
});

const SECRET = "CUSTOMER-SECRET-123";

const answeringSecret = (sensitive: boolean) =>
  Eval.make({
    dataset: Dataset.fromIterable(["a"], { id: (id) => id }),
    name: "secret",
    output: Schema.String,
    score: textScorer,
    sensitive,
    task: () => Effect.succeed(SECRET),
  });

const quoting = (required: boolean) =>
  Reporter.make({
    acceptsSensitive: true,
    name: "quoting",
    onCaseFinished: (event) =>
      Effect.fail(new Error(`cannot render ${JSON.stringify(Option.getOrNull(event.output))}`)),
    onComparison: (_base, head) =>
      Effect.fail(
        new Error(
          `cannot compare ${JSON.stringify(Option.getOrNull(head.outputs[0]?.output ?? Option.none()))}`,
        ),
      ),
    required,
  });

const loggedBy = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const lines: string[] = [];

    const exit = yield* self.pipe(
      Effect.exit,
      Effect.provide(
        Logger.layer([Logger.formatLogFmt.pipe(Logger.map((line) => lines.push(line)))]),
      ),
    );

    return { exit, logged: lines.join("\n") };
  });

describe("Runner.run reporter failures of a sensitive run", () => {
  it.effect("names the reporter that failed and never logs the error that quotes an output", () =>
    Effect.gen(function* () {
      const consumed = yield* loggedBy(
        Runner.run(answeringSecret(true)).pipe(Effect.provide(Reporter.layer([quoting(false)]))),
      );

      const run = yield* Runner.run(answeringSecret(true));

      const compared = yield* loggedBy(
        Reporter.compare(run, run).pipe(Effect.provide(Reporter.layer([quoting(false)]))),
      );

      expect(consumed.logged).toContain("The reporter quoting failed");
      expect(compared.logged).toContain("The reporter quoting failed to compare");
      expect([consumed.logged, compared.logged].join("\n")).not.toContain(SECRET);
    }),
  );

  it.effect("keeps the error of a required reporter out of the failure it returns", () =>
    Effect.gen(function* () {
      const consumed = yield* loggedBy(
        Runner.run(answeringSecret(true)).pipe(Effect.provide(Reporter.layer([quoting(true)]))),
      );

      const run = yield* Runner.run(answeringSecret(true));

      const compared = yield* loggedBy(
        Reporter.compare(run, run).pipe(Effect.provide(Reporter.layer([quoting(true)]))),
      );

      const pretty = [
        Exit.isFailure(consumed.exit) ? Cause.pretty(consumed.exit.cause) : "",
        Exit.isFailure(compared.exit) ? Cause.pretty(compared.exit.cause) : "",
      ];

      expect(pretty).toEqual([
        expect.stringContaining("The required reporter quoting failed."),
        expect.stringContaining("The required reporter quoting failed."),
      ]);
      expect([...pretty, consumed.logged, compared.logged].join("\n")).not.toContain(SECRET);
    }),
  );

  it.effect("logs the error of a reporter in full when the run is not sensitive", () =>
    Effect.gen(function* () {
      const consumed = yield* loggedBy(
        Runner.run(answeringSecret(false)).pipe(Effect.provide(Reporter.layer([quoting(false)]))),
      );

      const run = yield* Runner.run(answeringSecret(false));

      const compared = yield* loggedBy(
        Reporter.compare(run, run).pipe(Effect.provide(Reporter.layer([quoting(false)]))),
      );

      expect([consumed.logged, compared.logged]).toEqual([
        expect.stringMatching(new RegExp(`cannot render .*${SECRET}`, "u")),
        expect.stringMatching(new RegExp(`cannot compare .*${SECRET}`, "u")),
      ]);
    }),
  );
});

const HISTORY_SECRET = "CUSTOMER-SECRET-FROM-HISTORY";

const historyOf = (sensitive: boolean, answer: string) =>
  Eval.make({
    dataset: Dataset.fromIterable(["a"], { id: (id) => id }),
    name: "history-secret",
    output: Schema.String,
    score: textScorer,
    sensitive,
    task: () => Effect.succeed(answer),
  });

const quotedHistory = (history: View.HistorySnapshot) =>
  JSON.stringify(Option.getOrNull(history.recent[0]?.outputs[0]?.output ?? Option.none()));

const renderingHistory = Reporters.terminal({
  progress: false,
  view: (_run, history) => {
    throw new Error(`render failed on ${quotedHistory(history)}`);
  },
  write: () => Effect.void,
});

const comparingHistory = Reporter.make({
  acceptsSensitive: true,
  name: "history-compare",
  onComparison: (_base, head) =>
    History.snapshot(head).pipe(
      Effect.flatMap((history) =>
        Effect.fail(new Error(`compare failed on ${quotedHistory(history)}`)),
      ),
    ),
});

const afterHistory = (sensitive: boolean, reporter: Reporter.Reporter<Error, History.History>) =>
  Effect.gen(function* () {
    yield* Runner.run(historyOf(sensitive, HISTORY_SECRET)).pipe(
      Effect.provide(Reporter.layer([History.reporter])),
    );

    const consumed = yield* loggedBy(
      Runner.run(historyOf(false, "public")).pipe(Effect.provide(Reporter.layer([reporter]))),
    );

    const run = yield* Runner.run(historyOf(false, "public"));

    const compared = yield* loggedBy(
      Reporter.compare(run, run).pipe(Effect.provide(Reporter.layer([comparingHistory]))),
    );

    const requiredCompare = yield* loggedBy(
      Reporter.compare(run, run).pipe(
        Effect.provide(Reporter.layer([Reporter.required(comparingHistory)])),
      ),
    );

    return [
      consumed.logged,
      compared.logged,
      Exit.isFailure(consumed.exit) ? Cause.pretty(consumed.exit.cause) : "",
      Exit.isFailure(requiredCompare.exit) ? Cause.pretty(requiredCompare.exit.cause) : "",
    ].join("\n");
  }).pipe(Effect.provide(History.layerMemory));

describe("Runner.run reporter failures over sensitive history", () => {
  it.effect("never logs or returns the sensitive history a failing reporter quoted", () =>
    Effect.gen(function* () {
      const optional = yield* afterHistory(true, renderingHistory);
      const required = yield* afterHistory(true, Reporter.required(renderingHistory));

      expect(optional).toContain("The reporter terminal failed");
      expect(optional).toContain("The reporter history-compare failed to compare");
      expect(required).toContain("The required reporter terminal failed.");
      expect(required).toContain("The required reporter history-compare failed.");
      expect([optional, required].join("\n")).not.toContain(HISTORY_SECRET);
    }),
  );

  it.effect("logs the error in full when the history it read is not sensitive", () =>
    Effect.gen(function* () {
      const logged = yield* afterHistory(false, renderingHistory);

      expect(logged).toMatch(new RegExp(`render failed on .*${HISTORY_SECRET}`, "u"));
      expect(logged).toMatch(new RegExp(`compare failed on .*${HISTORY_SECRET}`, "u"));
    }),
  );
});

describe("Runner.run budget and retries", () => {
  it.effect("stops retrying once the task calls reach maxCalls", () =>
    Effect.gen(function* () {
      const attempts: string[] = [];

      const costly = Eval.make({
        budget: { maxCalls: 1 },
        dataset: Dataset.fromIterable(["a", "b"], { id: (id) => id }),
        name: "costly",
        retry: Schedule.recurs(2),
        score: textScorer,
        task: (input) =>
          Usage.record({ costUsd: 1 }).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                attempts.push(input.id);

                return attempts.length < 3 ? Effect.fail("rate limited") : Effect.succeed("x");
              }),
            ),
          ),
      });

      const run = yield* Runner.run(costly, { concurrency: 1 });

      expect(attempts).toEqual(["a"]);
      expect(run.variants[0]?.usage).toMatchObject({ calls: 1, costUsd: Option.some(1) });
      expect(run.outputs.map((output) => Option.getOrElse(output.failure, () => ""))).toEqual([
        expect.stringContaining("budget"),
        expect.stringContaining("budget"),
      ]);
    }),
  );

  it.effect(
    "counts a tracked stream in the usage of the run, finished or cut by a cancellation",
    () =>
      Effect.gen(function* () {
        const streaming = (parts: Stream.Stream<Response.StreamPartEncoded, AiError.AiError>) =>
          Eval.make({
            dataset: Dataset.fromIterable(["a"], { id: (id) => id }),
            name: "streaming",
            score: textScorer,
            task: () =>
              Stream.runDrain(LanguageModel.streamText({ prompt: "Categorize" })).pipe(
                Effect.as("a"),
                Effect.provide(
                  Usage.trackLanguageModel.pipe(
                    Layer.provide(
                      Layer.effect(
                        LanguageModel.LanguageModel,
                        LanguageModel.make({
                          generateText: () => Effect.never,
                          streamText: () => parts,
                        }),
                      ),
                    ),
                  ),
                ),
              ),
          });

        const started = yield* Deferred.make<boolean>();
        const events: EvalEvent[] = [];

        const finished = yield* Runner.run(
          streaming(
            Stream.make({
              reason: "stop",
              type: "finish",
              usage: { inputTokens: { total: 120 }, outputTokens: { total: 9 } },
            } as const),
          ),
        );

        const fiber = yield* Runner.run(
          streaming(
            Stream.fromEffect(Deferred.succeed(started, true)).pipe(
              Stream.drain,
              Stream.concat(Stream.never),
            ),
          ),
        ).pipe(Effect.provide(Reporter.layer([recording(events)])), Effect.forkChild);

        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        const cut = yield* Run.fold(events);

        expect(finished.variants[0]?.usage).toMatchObject({
          calls: 1,
          inputTokens: 120,
          outputTokens: 9,
        });
        expect(cut.variants[0]?.usage).toMatchObject({ calls: 1, costUsd: Option.none() });
      }),
  );

  it.effect("counts an attempt that times out against maxCalls and in the usage", () =>
    Effect.gen(function* () {
      const requests: string[] = [];

      const hanging = Layer.effect(
        LanguageModel.LanguageModel,
        LanguageModel.make({
          generateText: () =>
            Effect.sync(() => requests.push("request")).pipe(Effect.andThen(Effect.never)),
          streamText: () => Stream.empty,
        }),
      );

      const slow = Eval.make({
        budget: { maxCalls: 1 },
        dataset: Dataset.fromIterable(["a"], { id: (id) => id }),
        name: "slow",
        retry: Schedule.recurs(2),
        score: textScorer,
        task: () =>
          LanguageModel.generateText({ prompt: "Categorize" }).pipe(
            Effect.map((response) => response.text),
            Effect.provide(Usage.trackLanguageModel.pipe(Layer.provide(hanging))),
          ),
        timeout: Duration.millis(5),
      });

      const run = yield* Runner.run(slow);

      expect(requests).toEqual(["request"]);
      expect(run.variants[0]?.usage).toMatchObject({ calls: 1, costUsd: Option.none() });
      expect(run.outputs.map((output) => Option.getOrElse(output.failure, () => ""))).toEqual([
        expect.stringContaining("budget"),
      ]);
    }),
  );

  it.effect("counts every attempt it starts, even one that records no usage", () =>
    Effect.gen(function* () {
      const attempts: string[] = [];

      const flaky = Eval.make({
        budget: { maxCalls: 2 },
        dataset: Dataset.fromIterable(["a"], { id: (id) => id }),
        name: "flaky",
        retry: Schedule.recurs(5),
        score: textScorer,
        task: (input) =>
          Effect.suspend(() => {
            attempts.push(input.id);

            return Effect.fail("rate limited");
          }),
      });

      const run = yield* Runner.run(flaky);

      expect(attempts).toEqual(["a", "a"]);
      expect(run.outputs.map((output) => Option.getOrElse(output.failure, () => ""))).toEqual([
        expect.stringContaining("budget"),
      ]);
    }),
  );
});

const interruptedRun = <E>(
  self: Eval.Eval<string, string, E>,
  isTrigger: (event: EvalEvent) => boolean,
) =>
  Effect.gen(function* () {
    const events: EvalEvent[] = [];
    const target = yield* Deferred.make<Fiber.Fiber<Run.Run, unknown>>();

    const interrupting = Reporter.fromStream("interrupting", (stream) =>
      Stream.runForEach(stream, (event) =>
        Effect.sync(() => {
          events.push(event);
        }).pipe(
          Effect.andThen(
            isTrigger(event)
              ? Deferred.await(target).pipe(
                  Effect.flatMap((fiber) =>
                    Effect.sync(() => {
                      fiber.interruptUnsafe();
                    }),
                  ),
                )
              : Effect.void,
          ),
        ),
      ),
    );

    const fiber = yield* Runner.run(self).pipe(
      Effect.provide(Reporter.layer([interrupting])),
      Effect.forkDetach,
    );

    yield* Deferred.succeed(target, fiber);
    const exit = yield* withLive(Fiber.await(fiber).pipe(Effect.timeout(Duration.seconds(2))));

    return { events, exit };
  });

const spendThenHang = (signal: Deferred.Deferred<string>, costUsd: number, inputTokens: number) =>
  Usage.record({ costUsd, inputTokens }).pipe(
    Effect.andThen(Deferred.succeed(signal, "spent")),
    Effect.andThen(Effect.never),
  );

describe("Runner.run cancellation", () => {
  it.effect("ends the run when it is cancelled while it completes", () =>
    Effect.gen(function* () {
      const { events } = yield* interruptedRun(
        plain(() => Effect.succeed("x")),
        Events.isVariantFinished,
      );

      expect(events.filter(Events.isRunFinished)).toHaveLength(1);
    }),
  );

  it.effect("ends the run when it is cancelled while it starts", () =>
    Effect.gen(function* () {
      const many = Eval.make({
        dataset: Dataset.fromIterable(
          [
            "a",
            ...Array.from({ length: 10_000 }, (_, index) =>
              Dataset.skip(`skip-${String(index)}`, "no truth"),
            ),
          ],
          { id: (id: string) => id },
        ),
        name: "many",
        output: Schema.String,
        score: textScorer,
        task: () => Effect.succeed("x"),
      });

      const { events, exit } = yield* interruptedRun(many, Events.isRunStarted);

      expect(Exit.hasInterrupts(exit)).toBe(true);
      expect(events.filter(Events.isRunFinished)).toHaveLength(1);
    }),
  );

  it.effect(
    "commits usage interrupted inside its record to the run ledger, by a scorer or a task",
    () =>
      Effect.gen(function* () {
        const folded = (where: "scorer" | "task") =>
          Effect.gen(function* () {
            const events: EvalEvent[] = [];
            const reads = { calls: 0 };

            const trap: Usage.Usage = {
              get calls() {
                reads.calls += 1;

                if (reads.calls === 1) {
                  Fiber.getCurrent()?.interruptUnsafe();
                }

                return 1;
              },
              costUsd: Option.some(3),
              inputTokens: 100,
              labels: {},
              outputTokens: 10,
              reasoningTokens: 0,
            };

            yield* Runner.run(
              Eval.make({
                dataset: Dataset.fromIterable(["a"], { id: (id: string) => id }),
                name: "trapped",
                score: (input, outcome) =>
                  where === "scorer"
                    ? Usage.recordUsage(trap).pipe(Effect.andThen(textScorer(input, outcome)))
                    : textScorer(input, outcome),
                task: () =>
                  where === "task"
                    ? Usage.recordUsage(trap).pipe(Effect.andThen(Effect.never))
                    : Effect.succeed("x"),
              }),
            ).pipe(Effect.provide(Reporter.layer([recording(events)])), Effect.exit);
            const run = yield* Run.fold(events);

            return run.variants.map((variant) => [
              variant.usage.calls,
              variant.usage.inputTokens,
              variant.usage.costUsd,
            ]);
          });

        expect(yield* folded("task")).toEqual([[1, 100, Option.some(3)]]);
        expect(yield* folded("scorer")).toEqual([[1, 100, Option.some(3)]]);
      }),
  );

  it.effect("stops a run whose output encoder hangs, and keeps the spend of that case", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<boolean>();
      const never = yield* Deferred.make<string>();
      const events: EvalEvent[] = [];

      const hanging = Schema.String.pipe(
        Schema.decodeTo(
          Schema.String,
          SchemaTransformation.transformEffect({
            decode: (text) => Effect.succeed(text),
            encode: () =>
              Deferred.succeed(entered, true).pipe(Effect.andThen(Deferred.await(never))),
          }),
        ),
      );

      const fiber = yield* Runner.run(
        Eval.make({
          dataset: Dataset.fromIterable(["a"], { id: (id: string) => id }),
          name: "encoding",
          output: hanging,
          score: textScorer,
          task: () => Usage.record({ costUsd: 3, inputTokens: 40 }).pipe(Effect.as("a")),
        }),
      ).pipe(Effect.provide(Reporter.layer([recording(events)])), Effect.forkChild);

      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber).pipe(
        Effect.timeoutOrElse({
          duration: Duration.seconds(5),
          orElse: () => Effect.die("the run did not stop"),
        }),
        withLive,
      );
      const run = yield* Run.fold(events);

      expect(
        events.flatMap((event) => (Events.isRunFinished(event) ? [event.interrupted] : [])),
      ).toEqual([true]);
      expect(run.variants.map((variant) => [variant.usage.calls, variant.usage.costUsd])).toEqual([
        [1, Option.some(3)],
      ]);
    }),
  );

  it.effect("keeps the spend recorded before a cancellation, by the task or by a scorer", () =>
    Effect.gen(function* () {
      const folded = (build: (signal: Deferred.Deferred<string>) => Eval.Eval<string, string>) =>
        Effect.gen(function* () {
          const signal = yield* Deferred.make<string>();
          const events: EvalEvent[] = [];

          const fiber = yield* Runner.run(build(signal)).pipe(
            Effect.provide(Reporter.layer([recording(events)])),
            Effect.forkChild,
          );

          yield* Deferred.await(signal);
          yield* Fiber.interrupt(fiber);
          const run = yield* Run.fold(events);

          return run.variants.map((variant) => [
            variant.usage.calls,
            variant.usage.inputTokens,
            variant.usage.costUsd,
          ]);
        });

      const dataset = Dataset.fromIterable(["first", "second"], { id: (id: string) => id });

      const byTask = yield* folded((signal) =>
        Eval.make({
          dataset,
          name: "spending-task",
          score: textScorer,
          task: (input) =>
            input.id === "first"
              ? Usage.record({ costUsd: 1, inputTokens: 10 }).pipe(Effect.as("x"))
              : spendThenHang(signal, 7, 123),
        }),
      );

      const byScorer = yield* folded((signal) =>
        Eval.make({
          dataset,
          name: "spending-scorer",
          score: (input, outcome) =>
            input.id === "first"
              ? Usage.record({ costUsd: 1, inputTokens: 10 }).pipe(
                  Effect.andThen(textScorer(input, outcome)),
                )
              : spendThenHang(signal, 7, 123),
          task: () => Effect.succeed("x"),
        }),
      );

      expect([byTask, byScorer]).toEqual([[[2, 133, Option.some(8)]], [[2, 133, Option.some(8)]]]);
    }),
  );
});
