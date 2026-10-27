import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, Layer, Option } from "effect";
import * as Agreement from "../src/agreement.ts";
import * as Dataset from "../src/dataset.ts";
import * as Eval from "../src/eval.ts";
import type { Scored } from "../src/events.ts";
import * as Execution from "../src/execution.ts";
import * as Gate from "../src/gate.ts";
import * as Git from "../src/git.ts";
import * as History from "../src/history.ts";
import * as Metric from "../src/metric.ts";
import * as Observation from "../src/observation.ts";
import * as Reporter from "../src/reporter.ts";
import * as Runner from "../src/runner.ts";
import * as Scorer from "../src/scorer.ts";
import * as Variant from "../src/variant.ts";

const detail = { actual: "", expected: "" };

const scored = (
  id: string,
  agreement: Agreement.Agreement,
  tags: readonly string[] = [],
): Scored => ({
  case: id,
  observation: Observation.compared({ agreement, detail, key: id, tags }),
  trial: 1,
  variant: "default",
});

const missing = (id: string): Scored => ({
  case: id,
  observation: Observation.make({
    actual: Observation.actualStates.absent,
    detail,
    expected: Observation.expectedStates.present,
    key: id,
  }),
  trial: 1,
  variant: "default",
});

const evaluate = (gate: Gate.Gate, observations: readonly Scored[]) =>
  Gate.evaluate([gate], [{ observations, variant: "default" }]);

const eightOfTen = [
  ...["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => scored(id, Agreement.exact)),
  scored("i", Agreement.different),
  scored("j", Agreement.different),
];

describe("Gate.min", () => {
  it("passes when the value reaches the threshold and lists the cases that miss it", () => {
    const [result] = evaluate(Gate.min(Metric.accuracy, 0.8), eightOfTen);

    expect(result).toMatchObject({
      gate: "accuracy ≥ 0.8",
      passed: true,
      scope: Option.none(),
      threshold: "≥ 0.8",
      variant: "default",
    });
    expect(result?.violations.map((violation) => violation.case)).toEqual(["i", "j"]);
  });

  it("fails on the lower bound of the interval when asked to", () => {
    const [result] = evaluate(
      Gate.min(Metric.accuracy, 0.8, { on: Gate.bounds.lowerBound }),
      eightOfTen,
    );

    expect(result).toMatchObject({ gate: "accuracy (lower bound) ≥ 0.8", passed: false });
  });

  it("fails when the metric cannot be measured", () => {
    expect(evaluate(Gate.min(Metric.accuracy, 0.5), [])[0]?.passed).toBe(false);
  });

  it("passes a lower bound on meanAgreement when every agreement is exact", () => {
    const [result] = evaluate(Gate.min(Metric.meanAgreement, 0.8, { on: Gate.bounds.lowerBound }), [
      scored("a", Agreement.exact),
      scored("b", Agreement.exact),
    ]);

    expect(result?.passed).toBe(true);
  });
});

describe("Gate.max", () => {
  it("compares a count with the threshold", () => {
    const [result] = evaluate(Gate.max(Metric.wrong, 1), eightOfTen);

    expect(result).toMatchObject({ actual: "2", gate: "wrong ≤ 1", passed: false });
  });
});

const recipeGates = {
  categorizer: [
    Gate.max(Metric.wrong, 0),
    Gate.min(Metric.accuracy, 0.7),
    Gate.max(Metric.errored, 0),
  ],
  reconciliationMadeUp: [
    Gate.max(Metric.wrong, 0),
    Gate.missedOnlyOnGaps,
    Gate.max(Metric.errored, 0),
  ],
  reconciliationReal: [Gate.max(Metric.wrong, 0), Gate.max(Metric.errored, 0)],
};

const failing = (gates: readonly Gate.Gate[]) =>
  Runner.run(
    Eval.make({
      dataset: Dataset.fromIterable(["m1"], { id: (id: string) => id }),
      gates,
      name: "reconciliation",
      score: Scorer.label<string, string>({ actual: Option.some, expected: Scorer.present }),
      task: () => Effect.fail("database or provider failed"),
    }),
  ).pipe(Effect.flatMap(Runner.check), Effect.exit);

describe("the gates of the migration recipes", () => {
  it.effect("fail a reconciliation whose task fails", () =>
    Effect.gen(function* () {
      const madeUp = yield* failing(recipeGates.reconciliationMadeUp);
      const real = yield* failing(recipeGates.reconciliationReal);

      expect([Exit.isFailure(madeUp), Exit.isFailure(real)]).toEqual([true, true]);
    }),
  );

  it.effect("fail a categorizer whose first batch fails while the others are right", () =>
    Effect.gen(function* () {
      const labels = Array.from({ length: 50 }, (_, index) => `m${String(index)}`);

      const exit = yield* Runner.run(
        Eval.makeBatched({
          dataset: Dataset.fromIterable(labels, { id: (id: string) => id }),
          execution: Execution.batched(10),
          gates: recipeGates.categorizer,
          name: "categorizer",
          score: Scorer.label<string, string>({ actual: Option.some, expected: Scorer.present }),
          task: (page) =>
            page.some((entry) => entry.id === "m0")
              ? Effect.fail("provider failed")
              : Effect.succeed(page.map((entry) => entry.input)),
        }),
      ).pipe(Effect.flatMap(Runner.check), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});

describe("Gate.missedOnlyOnGaps", () => {
  it("passes when every missed value is a known gap", () => {
    const gap = missing("m1");

    expect(
      evaluate(Gate.missedOnlyOnGaps, [
        { ...gap, observation: Observation.knownGap("no reference")(gap.observation) },
      ])[0]?.passed,
    ).toBe(true);
  });

  it("fails on a missed value without a known gap", () => {
    expect(evaluate(Gate.missedOnlyOnGaps, [missing("m1")])[0]?.passed).toBe(false);
  });
});

describe("Gate.by", () => {
  it("checks the inner gate only on the observations with the tag", () => {
    const observations = [
      scored("tipoDocumento", Agreement.exact, ["group:fiscal"]),
      scored("natura", Agreement.exact, ["group:fiscal"]),
      scored("denominazione", Agreement.different, ["group:supplier"]),
    ];

    const [result] = evaluate(Gate.by("group:fiscal", Gate.min(Metric.accuracy, 1)), observations);

    expect(result).toMatchObject({
      gate: "accuracy ≥ 1 [group:fiscal]",
      passed: true,
      scope: Option.some("group:fiscal"),
    });
  });
});

describe("Gate.check", () => {
  it.effect("fails with the results that did not pass", () =>
    Effect.gen(function* () {
      const results = Gate.evaluate(
        [Gate.min(Metric.accuracy, 0.5), Gate.max(Metric.wrong, 0)],
        [{ observations: eightOfTen, variant: "default" }],
      );

      const failure = yield* Effect.flip(Gate.check(results));

      expect(failure.results.map((result) => result.gate)).toEqual(["wrong ≤ 0"]);
    }),
  );

  it.effect("hides the values and the failures of the violations of a sensitive run", () =>
    Effect.gen(function* () {
      const leaked: Scored = {
        case: "m1",
        observation: Observation.errored("natura", "Invalid response for RSSMRA80A01H501U", {
          detail: { actual: "RSSMRA80A01H501U", expected: "N6.3" },
          expected: Observation.expectedStates.present,
        }),
        trial: 1,
        variant: "default",
      };

      const results = Gate.evaluate(
        [Gate.max(Metric.errored, 0)],
        [{ observations: [leaked], variant: "default" }],
      );

      const failure = yield* Effect.flip(Gate.check(results, { sensitive: true }));

      expect(failure.message).not.toContain("RSSMRA80A01H501U");
      expect(failure.results[0]?.violations.map((violation) => violation.observation)).toEqual([
        expect.objectContaining({
          detail: { actual: "[redacted]", expected: "[redacted]" },
          failure: Option.some("[redacted]"),
        }),
      ]);
    }),
  );
});

const categorizer = (answers: Readonly<Record<string, string>>) =>
  Eval.make({
    dataset: Dataset.fromIterable(["m1", "m2", "m3"], { id: (id) => id }),
    gates: [Gate.noRegressions(History.latest)],
    name: "categorizer",
    score: Scorer.label<string, string>({
      actual: Option.some,
      expected: () => Scorer.present("rent"),
    }),
    task: (input) => Effect.succeed(answers[input.id] ?? "rent"),
  });

const saving = Reporter.layer([History.reporter]);

describe("Gate.noRegressions", () => {
  it.effect("fails without a stored run to compare with", () =>
    Effect.gen(function* () {
      const run = yield* Runner.run(categorizer({}));

      expect(run.gates).toMatchObject([{ actual: "no baseline", passed: false }]);
    }).pipe(Effect.provide(History.layerMemory)),
  );

  it.effect("passes when every case right in the baseline is still right", () =>
    Effect.gen(function* () {
      yield* Runner.run(categorizer({ m3: "fuel" })).pipe(Effect.provide(saving));

      const run = yield* Runner.run(categorizer({}));

      expect(run.gates).toMatchObject([{ actual: "0 regressions", passed: true }]);
    }).pipe(Effect.provide(History.layerMemory)),
  );

  it.effect("fails and lists the cases that were right in the baseline and are wrong now", () =>
    Effect.gen(function* () {
      yield* Runner.run(categorizer({})).pipe(Effect.provide(saving));

      const run = yield* Runner.run(categorizer({ m2: "fuel" }));

      expect(run.gates).toMatchObject([{ actual: "1 regressions", passed: false }]);
      expect(run.gates[0]?.violations.map((violation) => violation.case)).toEqual(["m2"]);
    }).pipe(Effect.provide(History.layerMemory)),
  );
});

describe("Gate.describe", () => {
  it("names the baseline of a regression gate", () => {
    expect(Gate.describe(Gate.noRegressions(History.baseline("main")))).toBe(
      "no regressions from the baseline on main",
    );
    expect(Gate.describe(Gate.noRegressions(History.baseline()))).toBe(
      "no regressions from the baseline on the base branch",
    );
  });
});

const onBranch = (branch: string) =>
  Git.layerStatic({ branch: Option.some(branch), dirty: false, sha: Option.none() });

const againstBaseline = (answers: Readonly<Record<string, string>>) =>
  Eval.make({
    dataset: Dataset.fromIterable(["m1", "m2"], { id: (id) => id }),
    gates: [Gate.noRegressions(History.baseline())],
    name: "categorizer",
    score: Scorer.label<string, string>({
      actual: Option.some,
      expected: () => Scorer.present("rent"),
    }),
    task: (input) => Effect.succeed(answers[input.id] ?? "rent"),
  });

const model = (name: string) => Variant.make(name, Layer.empty);

describe("Gate.noRegressions after an aborted run", () => {
  it.effect("keeps the last finished run as the baseline, latest and branch run", () =>
    Effect.gen(function* () {
      const onMain = Layer.merge(saving, onBranch("main"));
      const good = yield* Runner.run(againstBaseline({})).pipe(Effect.provide(onMain));

      const failed = yield* Effect.exit(
        Runner.run(againstBaseline({}), {
          variants: [Variant.make("default", Layer.effectDiscard(Effect.fail("no API key")))],
        }).pipe(Effect.provide(onMain)),
      );

      const aborted = (yield* History.list("categorizer")).find((entry) => entry.id !== good.id);

      const head = yield* Runner.run(againstBaseline({ m1: "fuel" })).pipe(
        Effect.provide(onBranch("feature/x")),
      );

      const selected = yield* Effect.forEach(
        [History.latest, History.onBranch("main"), History.baseline("main")],
        (selector) => History.load("categorizer", selector).pipe(Effect.map((run) => run.id)),
      );

      const byId = yield* History.load("categorizer", History.id(aborted?.id ?? ""));

      expect(Exit.isFailure(failed)).toBe(true);
      expect(head.gates).toMatchObject([{ actual: "1 regressions", passed: false }]);
      expect(selected).toEqual([good.id, good.id, good.id]);
      expect(byId.interrupted).toBe(true);
    }).pipe(
      Effect.provide(History.layerMemory),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
    ),
  );
});

describe("Gate.noRegressions with the default baseline", () => {
  it.effect("compares with the baseline of the configured base branch, at lookup", () =>
    Effect.gen(function* () {
      yield* Runner.run(againstBaseline({})).pipe(
        Effect.provide(Layer.merge(saving, onBranch("develop"))),
      );
      yield* Runner.run(againstBaseline({ m1: "fuel", m2: "fuel" })).pipe(
        Effect.provide(Layer.merge(saving, onBranch("main"))),
      );

      const run = yield* Runner.run(againstBaseline({ m1: "fuel" })).pipe(
        Effect.provide(onBranch("feature/x")),
        Effect.provideService(History.ConfiguredBaseBranch, Option.some("develop")),
      );

      expect(run.gates).toMatchObject([{ actual: "1 regressions", passed: false }]);
    }).pipe(
      Effect.provide(History.layerMemory),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
    ),
  );

  it.effect("lets EVAL_BASE_BRANCH win over the config", () =>
    Effect.gen(function* () {
      yield* Runner.run(againstBaseline({})).pipe(
        Effect.provide(Layer.merge(saving, onBranch("release"))),
      );

      const run = yield* Runner.run(againstBaseline({ m2: "fuel" })).pipe(
        Effect.provide(onBranch("feature/x")),
        Effect.provideService(History.ConfiguredBaseBranch, Option.some("develop")),
      );

      expect(run.gates).toMatchObject([{ actual: "1 regressions", passed: false }]);
    }).pipe(
      Effect.provide(History.layerMemory),
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { EVAL_BASE_BRANCH: "release" } })),
      ),
    ),
  );

  it.effect(
    "compares each variant with the newest baseline run that has it, as Vitest saves them",
    () =>
      Effect.gen(function* () {
        const onMain = Layer.merge(saving, onBranch("main"));
        yield* Runner.run(againstBaseline({}), { variants: [model("model-a")] }).pipe(
          Effect.provide(onMain),
        );
        yield* Runner.run(againstBaseline({}), { variants: [model("model-b")] }).pipe(
          Effect.provide(onMain),
        );

        const unchanged = yield* Runner.run(againstBaseline({}), {
          variants: [model("model-a")],
        }).pipe(Effect.provide(onBranch("feature/x")));

        const both = yield* Runner.run(againstBaseline({ m1: "fuel" }), {
          variants: [model("model-a"), model("model-b")],
        }).pipe(Effect.provide(onBranch("feature/x")));

        expect(unchanged.gates).toMatchObject([{ actual: "0 regressions", passed: true }]);
        expect(both.gates).toMatchObject([
          { actual: "1 regressions", passed: false, variant: "model-a" },
          { actual: "1 regressions", passed: false, variant: "model-b" },
        ]);
      }).pipe(
        Effect.provide(History.layerMemory),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
      ),
  );
});
