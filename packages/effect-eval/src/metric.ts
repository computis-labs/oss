import { Array as Arr, Data, Option, Schema } from "effect";
import { credit } from "./agreement.ts";
import { actualStates, expectedStates } from "./observation.ts";
import type { Observation } from "./observation.ts";
import { bootstrap, wilson } from "./statistics.ts";
import { verdicts } from "./verdict.ts";
import type { Verdict } from "./verdict.ts";
import * as Verdicts from "./verdict.ts";

const BOOTSTRAP_SEED = "effect-eval";
const NOT_MEASURABLE = "not measurable";
const DIGITS = 3;
const TAG_SEPARATOR = ":";

export interface Judged {
  readonly observation: Observation;
  readonly verdict: Verdict;
}

export const intervalMethods = {
  bootstrap: "bootstrap",
  wilsonUnlessPartial: "wilsonUnlessPartial",
} as const;

export type IntervalMethod = (typeof intervalMethods)[keyof typeof intervalMethods];

export type Metric = Data.TaggedEnum<{
  Count: { readonly name: string; readonly counts: (judged: Judged) => boolean };
  Ratio: {
    readonly name: string;
    readonly admits: (judged: Judged) => boolean;
    readonly weight: (judged: Judged) => number;
    readonly interval: IntervalMethod;
  };
}>;

export type CountMetric = Data.TaggedEnum.Value<Metric, "Count">;

export type RatioMetric = Data.TaggedEnum.Value<Metric, "Ratio">;

const { $is, $match, Count, Ratio } = Data.taggedEnum<Metric>();

export const isCount = $is("Count");

export const EstimateSchema = Schema.Struct({
  hits: Schema.Finite,
  interval: Schema.OptionFromNullOr(Schema.Tuple([Schema.Finite, Schema.Finite])),
  n: Schema.Finite,
  value: Schema.OptionFromNullOr(Schema.Finite),
});

export type Estimate = typeof EstimateSchema.Type;

const verdictCount = (verdict: Verdict) =>
  Count({ counts: (judged) => judged.verdict === verdict, name: verdict });

const isEvaluated = (judged: Judged) =>
  judged.verdict !== verdicts.excluded && judged.verdict !== verdicts.unscored;

const answeredBy = (judged: Judged) =>
  judged.observation.actual === actualStates.present && judged.verdict !== verdicts.errored;

const rightAnswer = (judged: Judged) =>
  judged.verdict === verdicts.right && judged.observation.actual === actualStates.present ? 1 : 0;

export const right = verdictCount(verdicts.right);
export const partial = verdictCount(verdicts.partial);
export const wrong = verdictCount(verdicts.wrong);
export const missed = verdictCount(verdicts.missed);
export const gaps = verdictCount(verdicts.gap);
export const unscored = verdictCount(verdicts.unscored);
export const errored = verdictCount(verdicts.errored);

export const excluded = (reason?: string) =>
  Count({
    counts: (judged) =>
      judged.verdict === verdicts.excluded &&
      (reason === undefined || Option.contains(judged.observation.excluded, reason)),
    name: reason === undefined ? verdicts.excluded : `${verdicts.excluded}(${reason})`,
  });

export const falsePositives = Count({
  counts: (judged) =>
    judged.verdict === verdicts.wrong && judged.observation.expected === expectedStates.absent,
  name: "falsePositives",
});

export const answered = Ratio({
  admits: (judged) => judged.verdict !== verdicts.excluded,
  interval: intervalMethods.wilsonUnlessPartial,
  name: "answered",
  weight: (judged) => (answeredBy(judged) ? 1 : 0),
});

export const precision = Ratio({
  admits: (judged) => isEvaluated(judged) && answeredBy(judged),
  interval: intervalMethods.wilsonUnlessPartial,
  name: "precision",
  weight: rightAnswer,
});

export const recall = Ratio({
  admits: (judged) => isEvaluated(judged) && judged.observation.expected === expectedStates.present,
  interval: intervalMethods.wilsonUnlessPartial,
  name: "recall",
  weight: rightAnswer,
});

export const accuracy = Ratio({
  admits: (judged) => isEvaluated(judged) && judged.observation.expected !== expectedStates.unknown,
  interval: intervalMethods.wilsonUnlessPartial,
  name: "accuracy",
  weight: (judged) =>
    judged.verdict === verdicts.right || judged.verdict === verdicts.partial
      ? Option.match(judged.observation.agreement, { onNone: () => 1, onSome: credit })
      : 0,
});

export const meanAgreement = Ratio({
  admits: (judged) =>
    isEvaluated(judged) &&
    judged.verdict !== verdicts.errored &&
    judged.observation.expected === expectedStates.present &&
    judged.observation.actual === actualStates.present,
  interval: intervalMethods.bootstrap,
  name: "meanAgreement",
  weight: (judged) =>
    Option.match(judged.observation.agreement, { onNone: () => 0, onSome: credit }),
});

export const counts = [right, partial, wrong, missed, gaps, unscored, errored, falsePositives];
export const ratios = [answered, precision, recall, accuracy, meanAgreement];

export const judge = (observations: readonly Observation[]): readonly Judged[] =>
  observations.map((observation) => ({ observation, verdict: Verdicts.of(observation) }));

export const count = (metric: CountMetric, judged: readonly Judged[]) =>
  judged.filter((item) => metric.counts(item)).length;

export const estimate = (metric: RatioMetric, judged: readonly Judged[]): Estimate => {
  const weights = judged.flatMap((item) => (metric.admits(item) ? [metric.weight(item)] : []));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const binary = weights.every((weight) => weight === 0 || weight === 1);

  return {
    hits: total,
    interval:
      binary && metric.interval === intervalMethods.wilsonUnlessPartial
        ? wilson(total, weights.length)
        : bootstrap(weights, { seed: BOOTSTRAP_SEED }),
    n: weights.length,
    value: weights.length === 0 ? Option.none() : Option.some(total / weights.length),
  };
};

export const value = (metric: Metric, judged: readonly Judged[]): Option.Option<number> =>
  $match(metric, {
    Count: (counted) => Option.some(count(counted, judged)),
    Ratio: (ratio) => estimate(ratio, judged).value,
  });

export const formatEstimate = (given: Estimate) =>
  Option.match(given.value, {
    onNone: () => NOT_MEASURABLE,
    onSome: (measured) =>
      `${measured.toFixed(DIGITS)}${Option.match(given.interval, {
        onNone: () => "",
        onSome: ([low, high]) => ` [${low.toFixed(DIGITS)}, ${high.toFixed(DIGITS)}]`,
      })} (n=${String(given.n)})`,
  });

export const SummarySchema = Schema.Struct({
  counts: Schema.Record(Schema.String, Schema.Finite),
  observations: Schema.Finite,
  ratios: Schema.Record(Schema.String, EstimateSchema),
});

export type Summary = typeof SummarySchema.Type;

export const summary = (observations: readonly Observation[]): Summary => {
  const judged = judge(observations);

  const reasons = [
    ...new Set(observations.flatMap((observation) => Option.toArray(observation.excluded))),
  ].toSorted();

  return {
    counts: Object.fromEntries([
      ...counts.map((metric) => [metric.name, count(metric, judged)] as const),
      [verdicts.excluded, count(excluded(), judged)] as const,
      ...reasons.map((reason) => {
        const byReason = excluded(reason);

        return [byReason.name, count(byReason, judged)] as const;
      }),
    ]),
    observations: observations.length,
    ratios: Object.fromEntries(ratios.map((metric) => [metric.name, estimate(metric, judged)])),
  };
};

const unmeasured: Estimate = { hits: 0, interval: Option.none(), n: 0, value: Option.none() };

export function read(summarized: Summary, metric: CountMetric): number;
export function read(summarized: Summary, metric: RatioMetric): Estimate;
export function read(summarized: Summary, metric: Metric): number | Estimate {
  return $match(metric, {
    Count: ({ name }) => summarized.counts[name] ?? 0,
    Ratio: ({ name }) => summarized.ratios[name] ?? unmeasured,
  });
}

export const by =
  (prefix: string) =>
  (observations: readonly Observation[]): Readonly<Record<string, Summary>> => {
    const head = `${prefix}${TAG_SEPARATOR}`;

    const groups = Arr.groupBy(
      observations.flatMap((observation) =>
        [
          ...new Set(
            observation.tags
              .filter((tag) => tag.startsWith(head))
              .map((tag) => tag.slice(head.length)),
          ),
        ].map((group) => [group, observation] as const),
      ),
      ([group]) => group,
    );

    return Object.fromEntries(
      Object.entries(groups).map(([group, entries]) => [
        group,
        summary(entries.map(([, observation]) => observation)),
      ]),
    );
  };
