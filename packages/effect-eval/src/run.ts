import { Array, Effect, Option, Stream } from "effect";
import type { DateTime, Schema } from "effect";
import { EvalHistoryError } from "./errors/eval-history-error.ts";
import {
  isCaseErrored,
  isCaseFinished,
  isCaseSkipped,
  isGateEvaluated,
  isRunFinished,
  isRunStarted,
  isVariantFinished,
} from "./events.ts";
import type {
  EvalEvent,
  GateResult,
  GitInfo,
  Judgement,
  Plan,
  Scored,
  TrialStats,
} from "./events.ts";
import * as Metric from "./metric.ts";
import type { Estimate, Judged, Summary } from "./metric.ts";
import { within } from "./observation.ts";
import {
  mcnemar,
  mean,
  pairedBootstrap,
  passAtK,
  passHatK,
  standardDeviation,
} from "./statistics.ts";
import { verdictClasses } from "./theme.ts";
import type { VerdictClass } from "./theme.ts";
import * as Usages from "./usage.ts";
import type { Usage } from "./usage.ts";
import { verdicts } from "./verdict.ts";
import type { Verdict } from "./verdict.ts";
import * as Verdicts from "./verdict.ts";

export const GROUP_PREFIX = "group";
export const LISTED_LIMIT = 20;

const LABEL_SEPARATOR = " · ";
const TRIAL_MARK = "trial ";

export interface VariantRun {
  readonly variant: string;
  readonly observations: readonly Scored[];
  readonly summary: Summary;
  readonly groups: Readonly<Record<string, Summary>>;
  readonly trials: Option.Option<TrialStats>;
  readonly usage: Usage;
  readonly durationMs: number;
}

export interface StoredOutput {
  readonly variant: string;
  readonly trial: number;
  readonly case: string;
  readonly inputHash: string;
  readonly output: Option.Option<Schema.Json>;
  readonly outputError: Option.Option<string>;
  readonly failure: Option.Option<string>;
  readonly judgements: readonly Judgement[];
}

export interface Run {
  readonly id: string;
  readonly eval: string;
  readonly startedAt: DateTime.Utc;
  readonly git: GitInfo;
  readonly datasetHash: string;
  readonly sensitive: boolean;
  readonly rescoreOf: Option.Option<string>;
  readonly plan: Plan;
  readonly trials: number;
  readonly variants: readonly VariantRun[];
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
  readonly gates: readonly GateResult[];
  readonly passed: boolean;
  readonly interrupted: boolean;
  readonly failedReporters: readonly string[];
  readonly durationMs: number;
  readonly outputs: readonly StoredOutput[];
}

const caseIdentityOf = (entry: {
  readonly variant: string;
  readonly case: string;
  readonly trial: number;
}) => JSON.stringify([entry.variant, entry.case, entry.trial]);

export const succeededObservations = (run: Run): readonly Scored[] => {
  const succeeded = new Set(
    run.outputs.filter((output) => Option.isNone(output.failure)).map(caseIdentityOf),
  );

  return run.variants.flatMap((variant) =>
    variant.observations.filter((entry) => succeeded.has(caseIdentityOf(entry))),
  );
};

const measured = (values: readonly number[]) =>
  values.length === 0 ? Option.none<readonly number[]>() : Option.some(values);

export const variantRun = (
  variant: string,
  observations: readonly Scored[],
  trials: number,
  usage: Usage,
  durationMs: number,
): VariantRun => {
  const plain = observations.map((item) => item.observation);

  const perTrial = Array.makeBy(trials, (index) =>
    Metric.summary(
      observations.flatMap((item) => (item.trial === index + 1 ? [item.observation] : [])),
    ),
  );

  const evaluated = observations.filter((scored) => {
    const verdict = Verdicts.of(scored.observation);

    return verdict !== verdicts.excluded && verdict !== verdicts.unscored;
  });

  const keyed = Object.values(
    Array.groupBy(evaluated, (scored) => JSON.stringify([scored.case, scored.observation.key])),
  ).map((items) => ({
    case: items[0].case,
    key: items[0].observation.key,
    verdicts: items.map((item) => Verdicts.of(item.observation)),
  }));

  const complete = keyed.filter((group) => group.verdicts.length >= trials);

  const averaged = (estimator: (n: number, correct: number, k: number) => number) =>
    Option.map(
      measured(
        complete.map((group) =>
          estimator(
            group.verdicts.length,
            group.verdicts.filter((verdict) => verdict === verdicts.right).length,
            trials,
          ),
        ),
      ),
      mean,
    );

  return {
    durationMs,
    groups: Metric.by(GROUP_PREFIX)(plain),
    observations,
    summary: Metric.summary(plain),
    trials:
      trials > 1
        ? Option.some({
            flaky: keyed.filter((group) => new Set(group.verdicts).size > 1),
            k: trials,
            metrics: Object.fromEntries(
              [
                ...Metric.counts.map((metric) => ({
                  name: metric.name,
                  valueOf: (summary: Metric.Summary) =>
                    Option.fromNullishOr(summary.counts[metric.name]),
                })),
                ...Metric.ratios.map((metric) => ({
                  name: metric.name,
                  valueOf: (summary: Metric.Summary) =>
                    Option.fromNullishOr(summary.ratios[metric.name]).pipe(
                      Option.flatMap((estimate) => estimate.value),
                    ),
                })),
              ].map(({ name, valueOf }) => {
                const values = measured(
                  perTrial.flatMap((summary) => Option.toArray(valueOf(summary))),
                );

                return [
                  name,
                  {
                    mean: values.pipe(Option.map(mean)),
                    standardDeviation: values.pipe(Option.map(standardDeviation)),
                  },
                ];
              }),
            ),
            passAtK: averaged(passAtK),
            passHatK: averaged(passHatK),
            shortOfK: keyed.length - complete.length,
          })
        : Option.none(),
    usage,
    variant,
  };
};

export const fold = Effect.fn("Run.fold")(function* foldEvents(events: readonly EvalEvent[]) {
  const started = events.find(isRunStarted);

  if (started === undefined) {
    return yield* new EvalHistoryError({ message: "The events of the run have no RunStarted." });
  }

  const finished = Option.fromNullishOr(events.find(isRunFinished));
  const cases = events.filter((event) => isCaseFinished(event) || isCaseErrored(event));
  const variantEvents = events.filter(isVariantFinished);

  const unreported = Option.match(finished, {
    onNone: () => [],
    onSome: (event) => event.unreportedUsage ?? [],
  });

  const variants = started.variants.map((variant): VariantRun => {
    const own = cases.filter((event) => event.variant === variant);

    const pending = unreported
      .filter((entry) => entry.variant === variant)
      .map((entry) => entry.usage);

    const observations = own.flatMap((event) =>
      event.observations.map((observation) => ({
        case: event.case,
        observation,
        trial: event.trial,
        variant,
      })),
    );

    return Option.match(
      Option.fromNullishOr(variantEvents.find((event) => event.variant === variant)),
      {
        onNone: () =>
          variantRun(
            variant,
            observations,
            started.trials,
            Usages.total([...own.map((event) => event.usage), ...pending]),
            0,
          ),
        onSome: (reported) => ({
          durationMs: reported.durationMs,
          groups: reported.groups,
          observations,
          summary: reported.summary,
          trials: reported.trials,
          usage: Usages.total([reported.usage, ...pending]),
          variant,
        }),
      },
    );
  });

  const run: Run = {
    datasetHash: started.datasetHash,
    durationMs: Option.match(finished, { onNone: () => 0, onSome: (event) => event.durationMs }),
    eval: started.eval,
    failedReporters: Option.match(finished, {
      onNone: () => [],
      onSome: (event) => event.failedReporters,
    }),
    gates: events.flatMap((event) =>
      isGateEvaluated(event)
        ? [
            {
              actual: event.actual,
              gate: event.gate,
              passed: event.passed,
              scope: event.scope,
              threshold: event.threshold,
              variant: event.variant,
              violations: event.violations,
            },
          ]
        : [],
    ),
    git: started.git,
    id: started.runId,
    interrupted: Option.match(finished, {
      onNone: () => true,
      onSome: (event) => event.interrupted,
    }),
    outputs: cases.map((event) => ({
      case: event.case,
      failure: isCaseErrored(event) ? Option.some(event.failure) : Option.none(),
      inputHash: event.inputHash,
      judgements: event.judgements,
      output: isCaseFinished(event) ? event.output : Option.none(),
      outputError: isCaseFinished(event) ? event.outputError : Option.none(),
      trial: event.trial,
      variant: event.variant,
    })),
    passed: Option.exists(finished, (event) => event.passed),
    plan: started.plan,
    rescoreOf: started.rescoreOf,
    sensitive: started.sensitive,
    skipped: events.flatMap((event) =>
      isCaseSkipped(event) ? [{ id: event.id, reason: event.reason }] : [],
    ),
    startedAt: started.at,
    trials: started.trials,
    variants,
  };

  return run;
});

export const fromEvents = <E, R>(events: Stream.Stream<EvalEvent, E, R>) =>
  Stream.runCollect(events).pipe(Effect.flatMap(fold));

export interface Transition {
  readonly variant: string;
  readonly case: string;
  readonly key: string;
  readonly trial: number;
  readonly from: Verdict;
  readonly to: Verdict;
  readonly before: Scored;
  readonly after: Scored;
}

export interface TransitionCount {
  readonly variant: string;
  readonly from: VerdictClass;
  readonly to: VerdictClass;
  readonly count: number;
}

export interface MetricDelta {
  readonly variant: string;
  readonly metric: string;
  readonly before: Estimate;
  readonly after: Estimate;
  readonly delta: Option.Option<number>;
  readonly interval: Option.Option<readonly [number, number]>;
  readonly pValue: Option.Option<number>;
}

export interface Comparison {
  readonly baseline: string;
  readonly run: string;
  readonly regressions: readonly Transition[];
  readonly fixes: readonly Transition[];
  readonly transitions: readonly TransitionCount[];
  readonly added: readonly Scored[];
  readonly removed: readonly Scored[];
  readonly deltas: readonly MetricDelta[];
}

const pairKey = (scored: Scored) =>
  JSON.stringify([scored.variant, scored.case, scored.observation.key, scored.trial]);

export const observationLabel = (scored: Scored) =>
  [
    scored.variant,
    within(scored.case, scored.observation.key),
    `${TRIAL_MARK}${String(scored.trial)}`,
  ].join(LABEL_SEPARATOR);

const isRight = (scored: Scored) => Verdicts.of(scored.observation) === verdicts.right;

export const transitionsOf = (
  before: readonly Scored[],
  after: readonly Scored[],
): readonly Transition[] => {
  const previous = new Map(before.map((scored) => [pairKey(scored), scored]));

  return after.flatMap((scored) =>
    Option.toArray(
      Option.map(Option.fromNullishOr(previous.get(pairKey(scored))), (earlier) => ({
        after: scored,
        before: earlier,
        case: scored.case,
        from: Verdicts.of(earlier.observation),
        key: scored.observation.key,
        to: Verdicts.of(scored.observation),
        trial: scored.trial,
        variant: scored.variant,
      })),
    ),
  );
};

export const regressionsOf = (transitions: readonly Transition[]) =>
  transitions.filter((transition) => isRight(transition.before) && !isRight(transition.after));

export const fixesOf = (transitions: readonly Transition[]) =>
  transitions.filter((transition) => !isRight(transition.before) && isRight(transition.after));

const unpaired = (from: readonly Scored[], against: readonly Scored[]) => {
  const present = new Set(against.map(pairKey));

  return from.filter((scored) => !present.has(pairKey(scored)));
};

const judgedOf = (scored: Scored): Judged => ({
  observation: scored.observation,
  verdict: Verdicts.of(scored.observation),
});

const DELTA_SEED = "effect-eval-delta";

export const compare = (run: Run, baseline: Run): Comparison => {
  const before = baseline.variants.flatMap((variant) => variant.observations);
  const after = run.variants.flatMap((variant) => variant.observations);
  const transitions = transitionsOf(before, after);
  const classes = Object.values(verdictClasses);

  const names = [
    ...new Set([...run.variants, ...baseline.variants].map((variant) => variant.variant)),
  ];

  return {
    added: unpaired(after, before),
    baseline: baseline.id,
    deltas: names.flatMap((name) => {
      const own = transitions.filter((transition) => transition.variant === name);

      const bothEvaluated = own.filter(
        (transition) =>
          Metric.accuracy.admits(judgedOf(transition.before)) &&
          Metric.accuracy.admits(judgedOf(transition.after)),
      );

      const pValue =
        bothEvaluated.length === 0
          ? Option.none<number>()
          : Option.some(
              mcnemar(regressionsOf(bothEvaluated).length, fixesOf(bothEvaluated).length).pValue,
            );

      return Metric.ratios.map((metric) => {
        const measuredPairs = own.filter(
          (transition) =>
            metric.admits(judgedOf(transition.before)) && metric.admits(judgedOf(transition.after)),
        );

        const left = Metric.estimate(
          metric,
          measuredPairs.map((transition) => judgedOf(transition.before)),
        );

        const right = Metric.estimate(
          metric,
          measuredPairs.map((transition) => judgedOf(transition.after)),
        );

        return {
          after: right,
          before: left,
          delta: Option.map(Option.all([left.value, right.value]), ([from, to]) => to - from),
          interval: pairedBootstrap(
            measuredPairs.map(
              (transition) =>
                [
                  metric.weight(judgedOf(transition.before)),
                  metric.weight(judgedOf(transition.after)),
                ] as const,
            ),
            { seed: DELTA_SEED },
          ),
          metric: metric.name,
          pValue: metric === Metric.accuracy ? pValue : Option.none(),
          variant: name,
        };
      });
    }),
    fixes: fixesOf(transitions),
    regressions: regressionsOf(transitions),
    removed: unpaired(before, after),
    run: run.id,
    transitions: names.flatMap((name) => {
      const own = transitions.flatMap((transition) =>
        transition.variant === name
          ? Option.toArray(
              Option.all([
                Verdicts.classOf(transition.before.observation),
                Verdicts.classOf(transition.after.observation),
              ]),
            )
          : [],
      );

      return classes.flatMap((from) =>
        classes.map((to) => ({
          count: own.filter(([left, right]) => left === from && right === to).length,
          from,
          to,
          variant: name,
        })),
      );
    }),
  };
};
