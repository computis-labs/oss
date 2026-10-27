import { Context, DateTime, Effect, Layer, Option } from "effect";
import * as Agreement from "../src/agreement.ts";
import * as Charts from "../src/chart.ts";
import type { Chart } from "../src/chart.ts";
import * as Dataset from "../src/dataset.ts";
import * as Eval from "../src/eval.ts";
import type { Scored } from "../src/events.ts";
import * as Gate from "../src/gate.ts";
import * as Git from "../src/git.ts";
import * as Metric from "../src/metric.ts";
import * as Observation from "../src/observation.ts";
import * as Run from "../src/run.ts";
import * as Runner from "../src/runner.ts";
import * as Scorer from "../src/scorer.ts";
import * as Usage from "../src/usage.ts";
import * as Variant from "../src/variant.ts";
import type { HistorySnapshot } from "../src/view.ts";

interface Movement {
  readonly id: string;
  readonly text: string;
  readonly category: string;
}

const movements: readonly Movement[] = [
  { category: "rent", id: "m1", text: "AFFITTO UFFICIO" },
  { category: "rent", id: "m2", text: "AFFITTO BOX" },
  { category: "fuel", id: "m3", text: "ENI STATION" },
  { category: "fuel", id: "m4", text: "Q8 <EASY>" },
];

const Answers = Context.Reference<Readonly<Record<string, string>>>("tests/Answers", {
  defaultValue: () => ({}),
});

const categorizer = Eval.make({
  dataset: Dataset.fromIterable([...movements, Dataset.skip("m5", "no ground truth")], {
    id: (movement: Movement) => movement.id,
    tags: (movement: Movement) => [`group:${movement.category}`],
  }),
  gates: [Gate.min(Metric.accuracy, 0.7), Gate.by("group:fuel", Gate.max(Metric.wrong, 0))],
  name: "categorizer",
  score: Scorer.label<Movement, string>({
    actual: Option.some,
    expected: (movement) => Scorer.present(movement.category),
  }),
  task: (input) =>
    Effect.service(Answers).pipe(
      Effect.tap(() => Usage.record({ costUsd: 0.002, inputTokens: 120, outputTokens: 8 })),
      Effect.map((answers) => answers[input.id] ?? input.input.category),
    ),
  trials: 2,
});

const variantsWith = (small: Readonly<Record<string, string>>) => [
  Variant.make("small", Layer.succeed(Answers, small)),
  Variant.make("large", Layer.succeed(Answers, {})),
];

const gitAt = (sha: string) =>
  Git.layerStatic({
    branch: Option.some("feature/categorizer"),
    dirty: true,
    sha: Option.some(sha),
  });

export const sampleRuns = Effect.gen(function* runSamples() {
  const base = yield* Runner.run(categorizer, { variants: variantsWith({ m3: "rent" }) }).pipe(
    Effect.provide(gitAt("fedcba9876543210")),
  );

  const head = yield* Runner.run(categorizer, {
    variants: variantsWith({ m1: "fuel", m2: "fuel" }),
  }).pipe(Effect.provide(gitAt("0123456789abcdef")));

  const history: HistorySnapshot = { baseline: Option.some(base), recent: [base] };

  return { base, head, history };
});

export const everyChart = sampleRuns.pipe(
  Effect.map(({ base, head }): readonly Chart[] => {
    const comparison = Run.compare(head, base);

    return [
      Charts.trend([base, head]),
      Charts.variants(head),
      Charts.delta(comparison, "small"),
      Charts.transitions(comparison, "small"),
      ...Charts.caseMap([base, head]).slice(0, 1),
      Charts.costVsAccuracy(head),
    ];
  }),
);

export const scoredAs = (options: {
  readonly case?: string;
  readonly variant?: string;
  readonly trial?: number;
  readonly right: boolean;
  readonly key?: string;
}): Scored => ({
  case: options.case ?? "a",
  observation: Observation.compared({
    agreement: options.right ? Agreement.exact : Agreement.different,
    detail: { actual: "", expected: "" },
    key: options.key ?? options.case ?? "a",
  }),
  trial: options.trial ?? 1,
  variant: options.variant ?? "default",
});

export const runOf = (id: string, observations: readonly Scored[], trials = 1): Run.Run => ({
  datasetHash: "",
  durationMs: 0,
  eval: "categorizer",
  failedReporters: [],
  gates: [],
  git: { branch: Option.none(), dirty: false, sha: Option.some("0123456789") },
  id,
  interrupted: false,
  outputs: [],
  passed: true,
  plan: { cases: 1, invocations: 1, skipped: 0 },
  rescoreOf: Option.none(),
  sensitive: false,
  skipped: [],
  startedAt: DateTime.makeUnsafe(0),
  trials,
  variants: [...new Set(observations.map((scored) => scored.variant))].map((variant) =>
    Run.variantRun(
      variant,
      observations.filter((scored) => scored.variant === variant),
      trials,
      Usage.empty,
      0,
    ),
  ),
});
