import { Data, Effect, Option } from "effect";
import { EvalGateFailed } from "./errors/eval-gate-failed.ts";
import type { GateResult, Scored } from "./events.ts";
import { describeSelector } from "./history.ts";
import type { Selector } from "./history.ts";
import * as Metric from "./metric.ts";
import type { Judged, RatioMetric } from "./metric.ts";
import { redactScored } from "./redact.ts";
import * as Runs from "./run.ts";
import type { Run } from "./run.ts";
import * as Verdicts from "./verdict.ts";

const MAX_VIOLATIONS = Runs.LISTED_LIMIT;

export const bounds = {
  lowerBound: "lowerBound",
  value: "value",
} as const;
export type Bound = (typeof bounds)[keyof typeof bounds];

export type Gate = Data.TaggedEnum<{
  Max: { readonly metric: Metric.Metric; readonly threshold: number };
  Min: { readonly metric: RatioMetric; readonly threshold: number; readonly on: Bound };
  By: { readonly tag: string; readonly gate: Gate };
  NoRegressions: { readonly baseline: Selector };
}>;

const { $match, By, Max, Min, NoRegressions } = Data.taggedEnum<Gate>();

export const max = (metric: Metric.Metric, threshold: number): Gate => Max({ metric, threshold });

export const min = (
  metric: RatioMetric,
  threshold: number,
  options: { readonly on?: Bound } = {},
): Gate => Min({ metric, on: options.on ?? bounds.value, threshold });

export const missedOnlyOnGaps = max(Metric.missed, 0);

export const by = (tag: string, gate: Gate): Gate => By({ gate, tag });

export const noRegressions = (baseline: Selector): Gate => NoRegressions({ baseline });

export const baselinesOf = (gates: readonly Gate[]): readonly Selector[] =>
  gates.flatMap((gate) =>
    $match(gate, {
      By: ({ gate: inner }) => baselinesOf([inner]),
      Max: () => [],
      Min: () => [],
      NoRegressions: ({ baseline }) => [baseline],
    }),
  );

export type Baselines = (selector: Selector) => Option.Option<Run>;

export const noBaselines: Baselines = () => Option.none();

export const describe = (gate: Gate): string =>
  $match(gate, {
    By: ({ gate: inner, tag }) => `${describe(inner)} [${tag}]`,
    Max: ({ metric, threshold }) => `${metric.name} ≤ ${String(threshold)}`,
    Min: ({ metric, on, threshold }) =>
      `${metric.name}${on === bounds.lowerBound ? " (lower bound)" : ""} ≥ ${String(threshold)}`,
    NoRegressions: ({ baseline }) => `no regressions from ${describeSelector(baseline)}`,
  });

const violationsOf = (
  items: readonly { readonly judged: Judged; readonly scored: Scored }[],
  violates: (judged: Judged) => boolean,
  limit: number,
) =>
  items
    .filter((item) => violates(item.judged))
    .map((item) => item.scored)
    .slice(0, limit);

const evaluateOne = (
  gate: Gate,
  variant: string,
  scope: Option.Option<string>,
  scored: readonly Scored[],
  baselines: Baselines,
  limit: number,
): GateResult => {
  const items = scored.map((entry) => ({
    judged: { observation: entry.observation, verdict: Verdicts.of(entry.observation) },
    scored: entry,
  }));
  const judged = items.map((item) => item.judged);
  const result = { gate: describe(gate), scope, variant };
  return $match(gate, {
    By: ({ gate: inner, tag }) => ({
      ...evaluateOne(
        inner,
        variant,
        Option.some(tag),
        scored.filter((entry) => new Set(entry.observation.tags).has(tag)),
        baselines,
        limit,
      ),
      gate: result.gate,
    }),
    Max: ({ metric, threshold }) => {
      const measured = Metric.value(metric, judged);
      return {
        ...result,
        actual: Metric.isCount(metric)
          ? String(Metric.count(metric, judged))
          : Metric.formatEstimate(Metric.estimate(metric, judged)),
        passed: Option.exists(measured, (value) => value <= threshold),
        threshold: `≤ ${String(threshold)}`,
        violations: violationsOf(
          items,
          (entry) =>
            Metric.isCount(metric)
              ? metric.counts(entry)
              : metric.admits(entry) && metric.weight(entry) > 0,
          limit,
        ),
      };
    },
    Min: ({ metric, on, threshold }) => {
      const estimate = Metric.estimate(metric, judged);
      const measured =
        on === bounds.lowerBound
          ? estimate.interval.pipe(Option.map(([low]) => low))
          : estimate.value;
      return {
        ...result,
        actual: Metric.formatEstimate(estimate),
        passed: Option.exists(measured, (value) => value >= threshold),
        threshold: `≥ ${String(threshold)}`,
        violations: violationsOf(
          items,
          (entry) => metric.admits(entry) && metric.weight(entry) < 1,
          limit,
        ),
      };
    },
    NoRegressions: ({ baseline }) => {
      const previous = Option.flatMap(baselines(baseline), (run) =>
        Option.fromNullishOr(run.variants.find((entry) => entry.variant === variant)),
      );
      return Option.match(previous, {
        onNone: () => ({
          ...result,
          actual: "no baseline",
          passed: false,
          threshold: "0 regressions",
          violations: [],
        }),
        onSome: (before) => {
          const regressions = Runs.regressionsOf(
            Runs.transitionsOf(before.observations, scored),
          ).map((transition) => transition.after);
          return {
            ...result,
            actual: `${String(regressions.length)} regressions`,
            passed: regressions.length === 0,
            threshold: "0 regressions",
            violations: regressions.slice(0, limit),
          };
        },
      });
    },
  });
};

export const evaluate = (
  gates: readonly Gate[],
  variants: readonly { readonly variant: string; readonly observations: readonly Scored[] }[],
  baselines: Baselines = noBaselines,
  limit = MAX_VIOLATIONS,
): readonly GateResult[] =>
  variants.flatMap((variant) =>
    gates.map((gate) =>
      evaluateOne(gate, variant.variant, Option.none(), variant.observations, baselines, limit),
    ),
  );

export const check = (
  results: readonly GateResult[],
  options: { readonly sensitive?: boolean } = {},
): Effect.Effect<void, EvalGateFailed> => {
  const failed = results
    .filter((result) => !result.passed)
    .map((result) => ({
      ...result,
      violations: result.violations
        .slice(0, MAX_VIOLATIONS)
        .map((scored) => (options.sensitive === true ? redactScored(scored) : scored)),
    }));
  return failed.length === 0 ? Effect.void : Effect.fail(new EvalGateFailed({ results: failed }));
};
