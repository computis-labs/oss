import { NodeServices } from "@effect/platform-node";
import { afterAll, beforeEach, describe, expect, it } from "@effect/vitest";
import { Config, Context, Effect, Equivalence, Layer, Option, PlatformError, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { TestConsole } from "effect/testing";
import * as Compare from "../src/compare.ts";
import type * as EvalConfig from "../src/config.ts";
import * as Dataset from "../src/dataset.ts";
import * as Eval from "../src/eval.ts";
import * as Events from "../src/events.ts";
import type { EvalEvent } from "../src/events.ts";
import * as Gate from "../src/gate.ts";
import * as Git from "../src/git.ts";
import * as History from "../src/history.ts";
import * as Metric from "../src/metric.ts";
import * as Reporter from "../src/reporter.ts";
import * as Reporters from "../src/reporters.ts";
import * as Runner from "../src/runner.ts";
import * as Scorer from "../src/scorer.ts";
import * as Variant from "../src/variant.ts";
import * as VitestEval from "../src/vitest.ts";

const Prefix = Context.Reference<string>("tests/Prefix", { defaultValue: () => "" });

const categorizer = Eval.make({
  dataset: Dataset.fromIterable(["rent", "fuel"], { id: (label: string) => label }),
  gates: [Gate.min(Metric.accuracy, 1)],
  name: "categorizer in vitest",
  score: Scorer.label<string, string>({ actual: Option.some, expected: Scorer.present }),
  task: (input) => Effect.service(Prefix).pipe(Effect.map((prefix) => `${prefix}${input.input}`)),
});

VitestEval.describe(categorizer, {
  history: false,
  layer: NodeServices.layer,
  variants: () => [
    Variant.make("plain", Layer.succeed(Prefix, "")),
    Variant.make("also plain", Layer.empty),
  ],
});

VitestEval.describe(categorizer, {
  history: false,
  layer: NodeServices.layer,
  skipUnless: { apiKey: Config.String("EFFECT_EVAL_TEST_KEY_THAT_IS_NEVER_SET") },
  variants: () => [Variant.make("would fail", Layer.succeed(Prefix, "x-"))],
});

VitestEval.guard(
  "movements",
  Dataset.guard({ rules: [{ name: "iban", pattern: /IT\d{2}[A-Z]\d{10}/u }] })(
    Dataset.fromIterable([{ id: "m1", text: "AFFITTO" }], { id: (movement) => movement.id }),
  ),
  Layer.empty,
);

const names = (reporters: readonly { readonly name: string; readonly required: boolean }[]) =>
  reporters.map((reporter) => [reporter.name, reporter.required]);

const write = () => Effect.void;

const recordingInto = (events: EvalEvent[]) =>
  Reporter.fromStream("recording", (stream) =>
    Stream.runForEach(stream, (event) => Effect.sync(() => events.push(event))),
  );

const sorted = (values: readonly string[]) => values.toSorted();

describe("EvalTest.describe with split case", () => {
  const events: EvalEvent[] = [];
  const testNames: string[] = [];
  const spawned: string[] = [];
  const recordingSpawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() =>
        spawned.push(
          ChildProcess.isStandardCommand(command)
            ? [command.command, ...command.args].join(" ")
            : "",
        ),
      ).pipe(
        Effect.andThen(
          Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              description: "no git in this test",
              method: "spawn",
              module: "ChildProcess",
            }),
          ),
        ),
      ),
    ),
  );

  beforeEach((context) => {
    testNames.push(context.task.name);
  });

  afterAll(() => {
    expect(sorted(testNames)).toEqual(sorted(["rent", "fuel", "gates"]));
    expect(events.filter(Events.isRunStarted)).toHaveLength(1);
    expect(spawned).toContain("git rev-parse HEAD");
  });

  VitestEval.describe(categorizer, {
    history: false,
    layer: Layer.merge(NodeServices.layer, recordingSpawner),
    reporters: [recordingInto(events)],
    split: "case",
    variants: () => [Variant.make("plain", Layer.succeed(Prefix, ""))],
  });
});

describe("EvalTest.describe with split case and a partial the gates accept", () => {
  VitestEval.describe(
    Eval.make({
      dataset: Dataset.fromIterable([{ id: "movement", invoices: ["invoice1", "invoice2"] }], {
        id: (movement) => movement.id,
      }),
      gates: [Gate.max(Metric.wrong, 0), Gate.missedOnlyOnGaps],
      name: "reconciliation in vitest",
      score: Scorer.set<
        { readonly id: string; readonly invoices: readonly string[] },
        readonly string[],
        string
      >({
        actual: (output) => output,
        compare: Compare.subset(Equivalence.String),
        expected: (movement) => Scorer.present(movement.invoices),
        show: (invoice) => invoice,
      }),
      task: () => Effect.succeed(["invoice1"]),
    }),
    { history: false, layer: NodeServices.layer, split: "case" },
  );
});

describe("EvalTest.describe with an explicit Git layer", () => {
  const events: EvalEvent[] = [];

  afterAll(() => {
    expect(events.filter(Events.isRunStarted).map((event) => event.git)).toEqual([
      { branch: Option.some("main"), dirty: false, sha: Option.some("abc1234") },
    ]);
  });

  VitestEval.describe(
    Eval.make({
      dataset: Dataset.fromIterable(["rent"], { id: (label: string) => label }),
      name: "categorizer with git",
      score: Scorer.label<string, string>({ actual: Option.some, expected: Scorer.present }),
      task: (input) => Effect.succeed(input.input),
    }),
    {
      history: false,
      layer: Layer.mergeAll(
        NodeServices.layer,
        Git.layerStatic({ branch: Option.some("main"), dirty: false, sha: Option.some("abc1234") }),
      ),
      reporters: [recordingInto(events)],
    },
  );
});

describe("EvalTest.describe variant selection", () => {
  it("refuses two variants with the same name before it registers a test", () => {
    expect(() => {
      VitestEval.describe(categorizer, {
        history: false,
        layer: NodeServices.layer,
        variants: () => [
          Variant.make("same", Layer.succeed(Prefix, "")),
          Variant.make("same", Layer.succeed(Prefix, "x-")),
        ],
      });
    }).toThrow(/same appears more than once/u);
  });

  it("refuses an empty selection, also with split case", () => {
    expect(() => {
      VitestEval.describe(categorizer, {
        history: false,
        layer: NodeServices.layer,
        split: "case",
        variants: () => [],
      });
    }).toThrow(/at least one variant/u);
  });
});

describe("EvalTest.reportersOf", () => {
  it.effect("takes a process reporter as a value and as a process tuple", () =>
    Effect.gen(function* () {
      const reporters = yield* VitestEval.reportersOf(
        {},
        {
          history: false,
          reporters: [
            Reporter.process("sink", "python", ["sink.py"]),
            ["process", { args: ["sink.py"], command: "python" }],
          ],
        },
        write,
      );

      expect(names(reporters)).toEqual([
        ["sink", false],
        ["process", false],
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("takes the reporters and the history setting from eval.config.ts unless given", () =>
    Effect.gen(function* () {
      const fromConfig = yield* VitestEval.reportersOf(
        { history: { enabled: false }, reporters: ["json", "history"] },
        {},
        write,
      );
      const defaults = yield* VitestEval.reportersOf({}, {}, write);
      const given = yield* VitestEval.reportersOf(
        { reporters: ["json"] },
        { reporters: ["markdown"] },
        write,
      );

      expect([names(fromConfig), names(defaults), names(given)]).toEqual([
        [["json", false]],
        [
          ["terminal", false],
          ["history", true],
        ],
        [["markdown", false]],
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves out a history reporter given as a value when history is off", () =>
    Effect.gen(function* () {
      const values = [History.reporter, Reporter.required(History.reporter)];
      const fromConfig = yield* VitestEval.reportersOf(
        { history: { enabled: false }, reporters: values },
        {},
        write,
      );
      const given = yield* VitestEval.reportersOf({}, { history: false, reporters: values }, write);

      expect([names(fromConfig), names(given)]).toEqual([[], []]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("buffers a terminal reporter given as a value like the one given by name", () =>
    Effect.gen(function* () {
      const failing = Eval.make({
        dataset: Dataset.fromIterable(["rent"], { id: (label: string) => label }),
        gates: [Gate.min(Metric.accuracy, 1)],
        name: "buffered",
        score: Scorer.label<string, string>({ actual: Option.some, expected: Scorer.present }),
        task: () => Effect.succeed("fuel"),
      });
      const outputOf = (entry: EvalConfig.ReporterEntry) =>
        Effect.gen(function* () {
          const buffered: string[] = [];
          const reporters = yield* VitestEval.reportersOf(
            {},
            { history: false, reporters: [entry] },
            (text) =>
              Effect.sync(() => {
                buffered.push(text);
              }),
          );
          const run = yield* Runner.run(failing).pipe(
            Effect.provide(Reporter.layer(reporters)),
            Effect.provide(History.layerMemory),
          );
          const live = yield* TestConsole.logLines;
          return { buffered, live: live.length, passed: run.passed };
        }).pipe(Effect.provide(TestConsole.layer));

      const outputs = yield* Effect.forEach(
        ["terminal", Reporters.terminal({ color: false })],
        outputOf,
      );

      expect(outputs.map(({ buffered, live, passed }) => [buffered.length, live, passed])).toEqual([
        [1, 0, false],
        [1, 0, false],
      ]);
      expect(outputs[1]?.buffered[0]).toContain("accuracy");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("EvalTest.checkCase", () => {
  it.effect("fails every case that breaks a gate, also past the violations a run lists", () =>
    Effect.gen(function* () {
      const labels = Array.from({ length: 30 }, (_, index) => `label-${String(index)}`);
      const allWrong = Eval.make({
        dataset: Dataset.fromIterable(labels, { id: (label: string) => label }),
        gates: [Gate.max(Metric.wrong, 0), Gate.min(Metric.accuracy, 1)],
        name: "all wrong",
        score: Scorer.label<string, string>({ actual: Option.some, expected: Scorer.present }),
        task: () => Effect.succeed("other"),
      });
      const run = yield* Runner.run(allWrong).pipe(
        Effect.provide(Reporter.layer([])),
        Effect.provide(History.layerMemory),
      );
      const failedCases = yield* Effect.all(
        labels.map((label) => Effect.isFailure(VitestEval.checkCase(allWrong.gates, run, label))),
      );

      expect(failedCases).toEqual(labels.map(() => true));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
