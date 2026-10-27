import { Array as Arr, Data, DateTime, Option } from "effect";
import type { Schema } from "effect";
import { within } from "./observation.ts";
import type { Comparison, Run, VariantRun } from "./run.ts";
import { seriesColor, verdictClasses } from "./theme.ts";
import type { Theme, VerdictClass } from "./theme.ts";
import * as Verdicts from "./verdict.ts";

export interface Interval {
  readonly value: number;
  readonly low: Option.Option<number>;
  readonly high: Option.Option<number>;
}

export interface TrendPoint extends Interval {
  readonly run: string;
  readonly label: string;
  readonly variant: string;
}

export interface Bar extends Interval {
  readonly variant: string;
}

export interface DeltaRow extends Interval {
  readonly metric: string;
}

export interface Column {
  readonly id: string;
  readonly label: string;
}

export interface Cell {
  readonly row: string;
  readonly column: string;
  readonly verdict: string;
}

export interface Transition {
  readonly from: VerdictClass;
  readonly to: VerdictClass;
  readonly count: number;
}

export interface CostPoint extends Interval {
  readonly variant: string;
  readonly cost: Option.Option<number>;
}

export type Chart = Data.TaggedEnum<{
  Trend: {
    readonly title: string;
    readonly metric: string;
    readonly points: readonly TrendPoint[];
  };
  Variants: { readonly title: string; readonly metric: string; readonly bars: readonly Bar[] };
  Delta: { readonly title: string; readonly rows: readonly DeltaRow[] };
  CaseMap: {
    readonly title: string;
    readonly variant: string;
    readonly rows: readonly string[];
    readonly columns: readonly Column[];
    readonly cells: readonly Cell[];
  };
  Transitions: { readonly title: string; readonly cells: readonly Transition[] };
  CostVsAccuracy: { readonly title: string; readonly points: readonly CostPoint[] };
}>;

export const { $is, $match, CaseMap, CostVsAccuracy, Delta, Transitions, Trend, Variants } =
  Data.taggedEnum<Chart>();

const SHA_LENGTH = 7;
const ACCURACY = "accuracy";

const intervalOf = (variant: VariantRun, metric: string): Option.Option<Interval> =>
  Option.fromNullishOr(variant.summary.ratios[metric]).pipe(
    Option.flatMap((estimate) =>
      estimate.value.pipe(
        Option.map((value) => ({
          high: estimate.interval.pipe(Option.map(([, high]) => high)),
          low: estimate.interval.pipe(Option.map(([low]) => low)),
          value,
        })),
      ),
    ),
  );

export const runLabel = (run: Run) =>
  `${DateTime.formatIso(run.startedAt).slice(0, 10)} ${Option.match(run.git.sha, {
    onNone: () => run.id.slice(0, SHA_LENGTH),
    onSome: (sha) => sha.slice(0, SHA_LENGTH),
  })}`;

export const trend = (runs: readonly Run[], metric: string = ACCURACY): Chart =>
  Trend({
    metric,
    points: runs.flatMap((run) =>
      run.variants.flatMap((variant) =>
        Option.toArray(
          Option.map(intervalOf(variant, metric), (interval) => ({
            ...interval,
            label: runLabel(run),
            run: run.id,
            variant: variant.variant,
          })),
        ),
      ),
    ),
    title: `${metric} over time`,
  });

export const variants = (run: Run, metric: string = ACCURACY): Chart =>
  Variants({
    bars: run.variants.flatMap((variant) =>
      Option.toArray(
        Option.map(intervalOf(variant, metric), (interval) => ({
          ...interval,
          variant: variant.variant,
        })),
      ),
    ),
    metric,
    title: `${metric} by variant`,
  });

export const delta = (comparison: Comparison, variant: string): Chart =>
  Delta({
    rows: comparison.deltas
      .filter((row) => row.variant === variant)
      .flatMap((row) =>
        Option.toArray(
          row.delta.pipe(
            Option.map((value) => ({
              high: row.interval.pipe(Option.map(([, high]) => high)),
              low: row.interval.pipe(Option.map(([low]) => low)),
              metric: row.metric,
              value,
            })),
          ),
        ),
      ),
    title: `${variant}: run ${comparison.run} against ${comparison.baseline}`,
  });

const TRIAL_SEPARATOR = "#";

const columnOf = (run: Run, trial: number): Column => ({
  id: `${run.id}${TRIAL_SEPARATOR}${String(trial)}`,
  label: run.trials > 1 ? `${runLabel(run)} ${TRIAL_SEPARATOR}${String(trial)}` : runLabel(run),
});

export const caseMap = (
  runs: readonly Run[],
  options: { readonly onlyUnstable?: boolean } = {},
): readonly Chart[] => {
  const names = [...new Set(runs.flatMap((run) => run.variants.map((variant) => variant.variant)))];

  return names.map((name) => {
    const columns = runs.flatMap((run) =>
      run.variants.some((variant) => variant.variant === name)
        ? Arr.range(1, run.trials).map((trial) => columnOf(run, trial))
        : [],
    );

    const cells = runs.flatMap((run) =>
      run.variants
        .filter((variant) => variant.variant === name)
        .flatMap((variant) =>
          variant.observations.map((scored) => ({
            column: columnOf(run, scored.trial).id,
            row: within(scored.case, scored.observation.key),
            verdict: Verdicts.of(scored.observation),
          })),
        ),
    );

    const rows = Object.entries(Arr.groupBy(cells, (cell) => cell.row))
      .filter(
        ([, group]) =>
          options.onlyUnstable !== true || new Set(group.map((cell) => cell.verdict)).size > 1,
      )
      .map(([row]) => row)
      .toSorted();

    const kept = new Set(rows);

    return CaseMap({
      cells: cells.filter((cell) => kept.has(cell.row)),
      columns,
      rows,
      title: `${name}: cases across runs`,
      variant: name,
    });
  });
};

export const transitions = (comparison: Comparison, variant: string): Chart =>
  Transitions({
    cells: comparison.transitions
      .filter((count) => count.variant === variant)
      .map((count) => ({ count: count.count, from: count.from, to: count.to })),
    title: `${variant}: verdicts from the baseline to this run`,
  });

export const costVsAccuracy = (run: Run): Chart =>
  CostVsAccuracy({
    points: run.variants.flatMap((variant) =>
      Option.toArray(
        Option.map(intervalOf(variant, ACCURACY), (interval) => ({
          ...interval,
          cost: variant.usage.costUsd,
          variant: variant.variant,
        })),
      ),
    ),
    title: "cost against accuracy",
  });

export interface VegaLiteSpec {
  readonly [key: string]: Schema.Json;
}

const SCHEMA_URL = "https://vega.github.io/schema/vega-lite/v6.json";
const CHART_WIDTH = 480;
const CHART_HEIGHT = 240;

const optional = (value: Option.Option<number>): Schema.Json => Option.getOrNull(value);

const intervalFields = (interval: Interval) => ({
  high: optional(interval.high),
  low: optional(interval.low),
  value: interval.value,
});

const config = (theme: Theme): Schema.Json => ({
  axis: {
    domainColor: theme.border,
    gridColor: theme.border,
    labelColor: theme.muted,
    labelFont: theme.font,
    tickColor: theme.border,
    titleColor: theme.muted,
    titleFont: theme.font,
  },
  axisX: { labelAngle: 0 },
  background: theme.surface,
  font: theme.font,
  legend: { labelColor: theme.text, labelFont: theme.font, titleColor: theme.muted },
  title: { color: theme.text, font: theme.font },
  view: { stroke: theme.border },
});

const variantScale = (names: readonly string[], theme: Theme): Schema.Json => ({
  domain: [...names],
  range: names.map((_, index) => seriesColor(theme, index)),
});

const labelled = (columns: readonly Column[]): Schema.Json => ({
  labelExpr: `${JSON.stringify(
    Object.fromEntries(columns.map((column) => [column.id, column.label])),
  )}[datum.value]`,
});

export const trendColumns = (points: readonly TrendPoint[]): readonly Column[] =>
  [...new Map(points.map((point) => [point.run, point.label]))].map(([id, label]) => ({
    id,
    label,
  }));

export const toVegaLite = (chart: Chart, theme: Theme): VegaLiteSpec => {
  const frame = {
    $schema: SCHEMA_URL,
    config: config(theme),
    height: CHART_HEIGHT,
    width: CHART_WIDTH,
  };

  return $match(chart, {
    CaseMap: ({ cells, columns, rows, title }) => ({
      ...frame,
      data: { values: cells.map((cell) => ({ ...cell })) },
      encoding: {
        color: {
          field: "verdict",
          scale: { domain: Object.keys(theme.verdicts), range: Object.values(theme.verdicts) },
          type: "nominal",
        },
        x: {
          axis: labelled(columns),
          field: "column",
          sort: columns.map((column) => column.id),
          title: null,
          type: "ordinal",
        },
        y: { field: "row", sort: [...rows], title: null, type: "ordinal" },
      },
      mark: { type: "rect" },
      title,
    }),
    CostVsAccuracy: ({ points, title }) => ({
      ...frame,
      data: {
        values: points.flatMap((point) =>
          Option.toArray(
            point.cost.pipe(
              Option.map((cost) => ({
                ...intervalFields(point),
                cost,
                variant: point.variant,
              })),
            ),
          ),
        ),
      },
      layer: [
        {
          encoding: {
            x: { field: "cost", type: "quantitative" },
            y: { field: "low", type: "quantitative" },
            y2: { field: "high" },
          },
          mark: { color: theme.muted, type: "rule" },
        },
        {
          encoding: {
            color: {
              field: "variant",
              scale: variantScale(
                points.map((point) => point.variant),
                theme,
              ),
              type: "nominal",
            },
            x: { field: "cost", title: "cost (USD)", type: "quantitative" },
            y: { field: "value", title: ACCURACY, type: "quantitative" },
          },
          mark: { filled: true, size: 80, type: "point" },
        },
      ],
      title,
    }),
    Delta: ({ rows, title }) => ({
      ...frame,
      data: { values: rows.map((row) => ({ ...intervalFields(row), metric: row.metric })) },
      layer: [
        { encoding: { x: { datum: 0 } }, mark: { color: theme.muted, type: "rule" } },
        {
          encoding: {
            x: { field: "low", type: "quantitative" },
            x2: { field: "high" },
            y: { field: "metric", title: null, type: "nominal" },
          },
          mark: { color: theme.muted, type: "rule" },
        },
        {
          encoding: {
            color: {
              condition: { test: "datum.value < 0", value: theme.tones.bad },
              value: theme.tones.good,
            },
            x: { field: "value", title: "delta", type: "quantitative" },
            y: { field: "metric", title: null, type: "nominal" },
          },
          mark: { filled: true, type: "point" },
        },
      ],
      title,
    }),
    Transitions: ({ cells, title }) => ({
      ...frame,
      data: { values: cells.map((cell) => ({ ...cell })) },
      encoding: {
        x: { field: "to", sort: Object.values(verdictClasses), title: "now", type: "ordinal" },
        y: {
          field: "from",
          sort: Object.values(verdictClasses),
          title: "baseline",
          type: "ordinal",
        },
      },
      layer: [
        {
          encoding: {
            color: {
              field: "count",
              scale: { range: [theme.surface, theme.text] },
              type: "quantitative",
            },
          },
          mark: { type: "rect" },
        },
        {
          encoding: { text: { field: "count", type: "quantitative" } },
          mark: { color: theme.muted, type: "text" },
        },
      ],
      title,
    }),
    Trend: ({ metric, points, title }) => {
      const names = [...new Set(points.map((point) => point.variant))];
      const columns = trendColumns(points);

      return {
        ...frame,
        data: {
          values: points.map((point) => ({
            ...intervalFields(point),
            label: point.label,
            run: point.run,
            variant: point.variant,
          })),
        },
        encoding: {
          color: { field: "variant", scale: variantScale(names, theme), type: "nominal" },
          x: {
            axis: labelled(columns),
            field: "run",
            sort: columns.map((column) => column.id),
            title: null,
            type: "ordinal",
          },
        },
        layer: [
          {
            encoding: { y: { field: "low", type: "quantitative" }, y2: { field: "high" } },
            mark: { opacity: 0.2, type: "area" },
          },
          {
            encoding: { y: { field: "value", title: metric, type: "quantitative" } },
            mark: { point: true, type: "line" },
          },
        ],
        title,
      };
    },
    Variants: ({ bars, metric, title }) => ({
      ...frame,
      data: { values: bars.map((bar) => ({ ...intervalFields(bar), variant: bar.variant })) },
      encoding: { x: { field: "variant", sort: null, title: null, type: "nominal" } },
      layer: [
        {
          encoding: {
            color: {
              field: "variant",
              legend: null,
              scale: variantScale(
                bars.map((bar) => bar.variant),
                theme,
              ),
              type: "nominal",
            },
            y: { field: "value", scale: { domain: [0, 1] }, title: metric, type: "quantitative" },
          },
          mark: { type: "bar" },
        },
        {
          encoding: { y: { field: "low", type: "quantitative" }, y2: { field: "high" } },
          mark: { color: theme.muted, type: "rule" },
        },
      ],
      title,
    }),
  });
};

export const hconcat = (specs: readonly VegaLiteSpec[], theme: Theme): VegaLiteSpec => ({
  $schema: SCHEMA_URL,
  config: config(theme),
  hconcat: specs.map(({ $schema: _schema, config: _config, ...rest }) => rest),
});
