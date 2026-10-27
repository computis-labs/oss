import { Data, Effect, Option, Predicate } from "effect";
import * as Charts from "./chart.ts";
import type { Chart } from "./chart.ts";
import type { Scored } from "./events.ts";
import * as Metric from "./metric.ts";
import { formatEstimate } from "./metric.ts";
import * as Runs from "./run.ts";
import type { Run } from "./run.ts";
import { tones } from "./theme.ts";
import type { Theme, Tone } from "./theme.ts";
import { unclassified } from "./scorer.ts";
import { verdicts } from "./verdict.ts";
import type { Verdict } from "./verdict.ts";
import * as Verdicts from "./verdict.ts";

export interface TableCell {
  readonly text: string;
  readonly tone: Tone;
}

export interface TableData {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly TableCell[])[];
}

export type Block = Data.TaggedEnum<{
  Section: { readonly title: string; readonly children: readonly Block[] };
  Row: { readonly children: readonly Block[] };
  Tabs: {
    readonly tabs: readonly { readonly title: string; readonly children: readonly Block[] }[];
  };
  Text: { readonly text: string; readonly tone: Tone };
  Badge: { readonly label: string; readonly tone: Tone };
  Table: TableData;
  Figure: { readonly chart: Chart; readonly fallback: TableData };
}>;

export const { $is, $match, Badge, Figure, Row, Section, Table, Tabs, Text } =
  Data.taggedEnum<Block>();

export type View = readonly Block[];

export interface HistorySnapshot {
  readonly baseline: Option.Option<Run>;
  readonly recent: readonly Run[];
}

export const emptyHistory: HistorySnapshot = { baseline: Option.none(), recent: [] };

export const drawingKinds = {
  html: "html",
  markdown: "markdown",
  terminal: "terminal",
  text: "text",
} as const;

export type DrawingKind = (typeof drawingKinds)[keyof typeof drawingKinds];

export interface Drawing {
  readonly kind: DrawingKind;
  readonly content: string;
}

export const drawing = (kind: DrawingKind, content: string): Drawing => ({ content, kind });

export interface RenderOptions {
  readonly theme: Theme;
  readonly width: number;
  readonly accepts: readonly DrawingKind[];
}

export type ChartRenderer<E = never, R = never> = (
  charts: readonly Chart[],
  options: RenderOptions,
) => Effect.Effect<Option.Option<Drawing>, E, R>;

export const unsupported: ChartRenderer = () => Effect.succeedNone;

export const drawWith =
  <E, R>(renderer: ChartRenderer<E, R>) =>
  (charts: readonly Chart[], options: RenderOptions) => {
    const accepted = new Set(options.accepts);

    return renderer(charts, options).pipe(
      Effect.map(Option.filter((drawn) => accepted.has(drawn.kind))),
    );
  };

export const firstOf =
  <E, R>(...renderers: readonly ChartRenderer<E, R>[]): ChartRenderer<E, R> =>
  (charts, options) =>
    Effect.reduce(
      renderers,
      () => Option.none<Drawing>(),
      (found, renderer) =>
        Option.isSome(found) ? Effect.succeed(found) : drawWith(renderer)(charts, options),
    );

const DIGITS = 3;
const PERCENT = 100;
const MAX_ROWS = 40;
const NOTHING = "—";
const NOT_AVAILABLE = "n/a";
const SHA_LENGTH = 7;
const MILLIS_PER_SECOND = 1000;

export const cell = (text: string, tone: Tone = tones.neutral): TableCell => ({ text, tone });

export const table = (
  columns: readonly string[],
  rows: readonly (readonly (string | TableCell)[])[],
) =>
  Table({
    columns,
    rows: rows.map((row) => row.map((value) => (Predicate.isString(value) ? cell(value) : value))),
  });

const optionalNumber = (value: Option.Option<number>) =>
  Option.match(value, { onNone: () => NOTHING, onSome: (number) => number.toFixed(DIGITS) });

export const signed = (value: number) =>
  `${value > 0 ? "+" : ""}${(value * PERCENT).toFixed(1)} pt`;

export const outcomeLabel = (run: { readonly interrupted: boolean; readonly passed: boolean }) => {
  if (run.interrupted) {
    return "interrupted";
  }

  return run.passed ? "passed" : "failed";
};

export const chartTable = (chart: Chart): TableData =>
  Charts.$match(chart, {
    CaseMap: ({ cells, columns, rows }) => ({
      columns: ["case", ...columns.map((column) => column.label)],
      rows: rows.map((row) => [
        cell(row),
        ...columns.map((column) =>
          cell(
            cells.find((entry) => entry.row === row && entry.column === column.id)?.verdict ??
              NOTHING,
          ),
        ),
      ]),
    }),
    CostVsAccuracy: ({ points }) => ({
      columns: ["variant", "cost", "accuracy", "low", "high"],
      rows: points.map((point) =>
        [
          point.variant,
          Option.match(point.cost, {
            onNone: () => NOT_AVAILABLE,
            onSome: (cost) => cost.toFixed(DIGITS),
          }),
          point.value.toFixed(DIGITS),
          optionalNumber(point.low),
          optionalNumber(point.high),
        ].map((text) => cell(text)),
      ),
    }),
    Delta: ({ rows }) => ({
      columns: ["metric", "delta", "low", "high"],
      rows: rows.map((row) => [
        cell(row.metric),
        cell(signed(row.value), row.value < 0 ? tones.bad : tones.good),
        cell(Option.match(row.low, { onNone: () => NOTHING, onSome: signed })),
        cell(Option.match(row.high, { onNone: () => NOTHING, onSome: signed })),
      ]),
    }),
    Transitions: ({ cells }) => ({
      columns: ["baseline", "now", "count"],
      rows: cells
        .filter((entry) => entry.count > 0)
        .map((entry) => [cell(entry.from), cell(entry.to), cell(String(entry.count))]),
    }),
    Trend: ({ points }) => ({
      columns: ["run", "variant", "value", "low", "high"],
      rows: points.map((point) =>
        [
          point.label,
          point.variant,
          point.value.toFixed(DIGITS),
          optionalNumber(point.low),
          optionalNumber(point.high),
        ].map((text) => cell(text)),
      ),
    }),
    Variants: ({ bars }) => ({
      columns: ["variant", "value", "low", "high"],
      rows: bars.map((bar) =>
        [
          bar.variant,
          bar.value.toFixed(DIGITS),
          optionalNumber(bar.low),
          optionalNumber(bar.high),
        ].map((text) => cell(text)),
      ),
    }),
  });

export const figure = (chart: Chart) => Figure({ chart, fallback: chartTable(chart) });

const toLookAt = new Set<Verdict>([
  verdicts.wrong,
  verdicts.missed,
  verdicts.partial,
  verdicts.errored,
]);

const verdictTones = {
  [verdicts.errored]: tones.info,
  [verdicts.excluded]: tones.neutral,
  [verdicts.gap]: tones.neutral,
  [verdicts.missed]: tones.bad,
  [verdicts.partial]: tones.warn,
  [verdicts.right]: tones.good,
  [verdicts.unscored]: tones.neutral,
  [verdicts.wrong]: tones.bad,
} as const satisfies Record<Verdict, Tone>;

export const groupTable = (run: Run) =>
  Table({
    columns: ["variant", "group", "accuracy", "recall", "precision"],
    rows: run.variants.flatMap((variant) =>
      Object.entries(variant.groups).map(([group, groupSummary]) => [
        cell(variant.variant),
        cell(group),
        ...[Metric.accuracy, Metric.recall, Metric.precision].map((metric) => {
          const estimate = groupSummary.ratios[metric.name];

          return cell(estimate === undefined ? NOTHING : formatEstimate(estimate));
        }),
      ]),
    ),
  });

export const observationTable = (scored: readonly Scored[]) => {
  const shown = scored.slice(0, MAX_ROWS);
  const noted = shown.some((entry) => entry.observation.detail.note !== undefined);

  return Table({
    columns: [
      "variant",
      "case",
      "key",
      "verdict",
      "expected",
      "actual",
      ...(noted ? ["note"] : []),
    ],
    rows: shown.map((entry) => {
      const verdict = Verdicts.of(entry.observation);

      const label = Option.match(
        verdict === verdicts.excluded ? entry.observation.excluded : Option.none<string>(),
        {
          onNone: () =>
            verdict === verdicts.right && Option.isSome(entry.observation.gap)
              ? `${verdict} (gap closed)`
              : verdict,
          onSome: (reason) => `${verdict}(${reason})`,
        },
      );

      return [
        cell(entry.variant),
        cell(entry.case),
        cell(entry.observation.key),
        cell(label, verdictTones[verdict]),
        cell(entry.observation.detail.expected),
        cell(Option.getOrElse(entry.observation.failure, () => entry.observation.detail.actual)),
        ...(noted ? [cell(entry.observation.detail.note ?? "")] : []),
      ];
    }),
  });
};

const header = (run: Run): Block =>
  Row({
    children: [
      Badge({ label: outcomeLabel(run), tone: run.passed ? tones.good : tones.bad }),
      Text({
        text: `${run.eval} · run ${run.id}${Option.match(run.git.branch, {
          onNone: () => "",
          onSome: (branch) => ` · ${branch}`,
        })}${Option.match(run.git.sha, {
          onNone: () => "",
          onSome: (sha) => ` @ ${sha.slice(0, SHA_LENGTH)}`,
        })}${run.git.dirty ? " (dirty)" : ""}${Option.match(run.rescoreOf, {
          onNone: () => "",
          onSome: (source) => ` · rescore of ${source}`,
        })}`,
        tone: tones.neutral,
      }),
    ],
  });

const identityOf = (scored: Scored) =>
  JSON.stringify([scored.variant, scored.case, scored.trial, scored.observation.key]);

export const summary = (run: Run, history: HistorySnapshot = emptyHistory): View => {
  const failedGates = run.gates.filter((gate) => !gate.passed && gate.violations.length > 0);
  const violating = new Set(failedGates.flatMap((gate) => gate.violations.map(identityOf)));

  const priorityOf = (scored: Scored) => {
    if (Option.contains(scored.observation.excluded, unclassified)) {
      return 0;
    }

    return violating.has(identityOf(scored)) ? 1 : 2;
  };

  const toReview = run.variants
    .flatMap((variant) => variant.observations)
    .filter((scored) => {
      const verdict = Verdicts.of(scored.observation);

      return (
        toLookAt.has(verdict) ||
        Option.contains(scored.observation.excluded, unclassified) ||
        (verdict === verdicts.right && Option.isSome(scored.observation.gap)) ||
        violating.has(identityOf(scored))
      );
    })
    .toSorted((left, right) => priorityOf(left) - priorityOf(right));

  const countNames = [...Metric.counts.map((metric) => metric.name), verdicts.excluded];

  const exclusions = run.variants.flatMap((variant) =>
    [
      ...new Set(
        variant.observations.flatMap((scored) => Option.toArray(scored.observation.excluded)),
      ),
    ]
      .toSorted()
      .map((reason) => [
        variant.variant,
        reason,
        String(Metric.read(variant.summary, Metric.excluded(reason))),
      ]),
  );

  const notStored = run.outputs.flatMap((output) =>
    Option.toArray(output.outputError).map((reason) => [output, reason] as const),
  );

  const trialed = run.variants.flatMap((variant) =>
    Option.toArray(variant.trials).map((stats) => [variant.variant, stats] as const),
  );

  const comparison = history.baseline.pipe(Option.map((baseline) => Runs.compare(run, baseline)));

  const unpaired = comparison.pipe(
    Option.filter((compared) => compared.added.length > 0 || compared.removed.length > 0),
  );

  return [
    header(run),
    Text({
      text: run.variants
        .map(
          (variant) =>
            `${variant.variant}: ${String(variant.usage.calls)} calls, ${String(
              variant.usage.inputTokens + variant.usage.outputTokens,
            )} tokens${Option.match(variant.usage.costUsd, {
              onNone: () => (variant.usage.calls > 0 ? ", cost unknown" : ""),
              onSome: (cost) => `, $${cost.toFixed(DIGITS)}`,
            })}, ${(variant.durationMs / MILLIS_PER_SECOND).toFixed(1)} s`,
        )
        .join(" · "),
      tone: tones.neutral,
    }),
    Section({
      children: [
        Table({
          columns: ["variant", "metric", "value", "n", "Δ baseline (paired)"],
          rows: run.variants.flatMap((variant) =>
            Metric.ratios.map((metric) => {
              const estimate = variant.summary.ratios[metric.name];

              const delta = comparison.pipe(
                Option.flatMap((compared) =>
                  Option.fromNullishOr(
                    compared.deltas.find(
                      (entry) => entry.variant === variant.variant && entry.metric === metric.name,
                    ),
                  ),
                ),
                Option.flatMap((entry) => entry.delta),
              );

              return [
                cell(variant.variant),
                cell(metric.name),
                cell(estimate === undefined ? NOTHING : formatEstimate(estimate)),
                cell(estimate === undefined ? NOTHING : String(estimate.n)),
                Option.match(delta, {
                  onNone: () => cell(NOTHING),
                  onSome: (change) => cell(signed(change), change < 0 ? tones.bad : tones.good),
                }),
              ];
            }),
          ),
        }),
        ...Option.toArray(unpaired).map((compared) =>
          Text({
            text: `Δ baseline uses only the observations both runs have: ${String(
              compared.added.length,
            )} added and ${String(compared.removed.length)} removed stay out of it.`,
            tone: tones.neutral,
          }),
        ),
        Table({
          columns: ["variant", ...countNames],
          rows: run.variants.map((variant) => [
            cell(variant.variant),
            ...countNames.map((name) => cell(String(variant.summary.counts[name] ?? 0))),
          ]),
        }),
      ],
      title: "Metrics",
    }),
    Section({
      children: [
        Table({
          columns: ["variant", "trial", "succeeded", "failed"],
          rows: run.variants.flatMap((variant) =>
            Array.from({ length: run.trials }, (_, index) => {
              const outcomes = run.outputs.filter(
                (output) => output.variant === variant.variant && output.trial === index + 1,
              );

              const failed = outcomes.filter((output) => Option.isSome(output.failure)).length;

              return [
                cell(variant.variant),
                cell(String(index + 1)),
                cell(String(outcomes.length - failed), tones.good),
                cell(String(failed), failed > 0 ? tones.bad : tones.neutral),
              ];
            }),
          ),
        }),
      ],
      title: "Cases",
    }),
    ...(exclusions.length === 0
      ? []
      : [
          Section({
            children: [table(["variant", "reason", "count"], exclusions)],
            title: "Exclusions",
          }),
        ]),
    ...(run.variants.some((variant) => Object.keys(variant.groups).length > 0)
      ? [Section({ children: [groupTable(run)], title: "Groups" })]
      : []),
    ...(run.variants.length > 1
      ? [Section({ children: [figure(Charts.variants(run))], title: "Variants" })]
      : []),
    ...(trialed.length === 0
      ? []
      : [
          Section({
            children: [
              Table({
                columns: ["variant", "metric", "mean", "sd"],
                rows: trialed.flatMap(([variant, stats]) =>
                  [...Metric.counts, ...Metric.ratios].map((metric) => {
                    const measured = stats.metrics[metric.name];

                    return [
                      cell(variant),
                      cell(metric.name),
                      cell(optionalNumber(measured?.mean ?? Option.none())),
                      cell(optionalNumber(measured?.standardDeviation ?? Option.none())),
                    ];
                  }),
                ),
              }),
              ...trialed.map(([variant, stats]) => {
                const k = String(stats.k);

                return Text({
                  text: Option.match(Option.all([stats.passAtK, stats.passHatK]), {
                    onNone: () =>
                      `${variant}: pass@${k} and pass^${k} unavailable: no observation was measured in all ${k} trials`,
                    onSome: ([atK, hatK]) =>
                      `${variant}: pass@${k} ${atK.toFixed(DIGITS)}, pass^${k} ${hatK.toFixed(DIGITS)}${
                        stats.shortOfK > 0
                          ? `, leaving out ${String(stats.shortOfK)} observations measured in fewer than ${k} trials`
                          : ""
                      }`,
                  }),
                  tone: tones.neutral,
                });
              }),
              ...(trialed.some(([, stats]) => stats.flaky.length > 0)
                ? [
                    table(
                      ["variant", "case", "key", "verdicts"],
                      trialed.flatMap(([variant, stats]) =>
                        stats.flaky.map((group) => [
                          variant,
                          group.case,
                          group.key,
                          group.verdicts.join(", "),
                        ]),
                      ),
                    ),
                  ]
                : []),
            ],
            title: "Trials",
          }),
        ]),
    ...(run.gates.length === 0
      ? []
      : [
          Section({
            children: [
              Table({
                columns: ["variant", "gate", "actual", "result"],
                rows: run.gates.map((gate) => [
                  cell(gate.variant),
                  cell(gate.gate),
                  cell(gate.actual),
                  cell(gate.passed ? "pass" : "fail", gate.passed ? tones.good : tones.bad),
                ]),
              }),
            ],
            title: "Gates",
          }),
        ]),
    ...(failedGates.length === 0
      ? []
      : [
          Section({
            children: failedGates.map((gate) =>
              Section({
                children: [
                  observationTable(gate.violations.slice(0, Runs.LISTED_LIMIT)),
                  ...(gate.violations.length > Runs.LISTED_LIMIT
                    ? [
                        Text({
                          text: `+${String(gate.violations.length - Runs.LISTED_LIMIT)} more; see the JSON reporter or history for all gate violations.`,
                          tone: tones.neutral,
                        }),
                      ]
                    : []),
                ],
                title: `${gate.variant} · ${gate.gate}`,
              }),
            ),
            title: "Gate violations",
          }),
        ]),
    ...(toReview.length === 0
      ? []
      : [
          Section({
            children: [
              observationTable(toReview),
              ...(toReview.length > MAX_ROWS
                ? [
                    Text({
                      text: `+${String(toReview.length - MAX_ROWS)} more; see the JSON reporter or history for all observations.`,
                      tone: tones.neutral,
                    }),
                  ]
                : []),
            ],
            title: "To look at",
          }),
        ]),
    ...(run.skipped.length === 0
      ? []
      : [
          Section({
            children: [
              table(
                ["case", "reason"],
                run.skipped.map((skipped) => [skipped.id, skipped.reason]),
              ),
            ],
            title: "Skipped",
          }),
        ]),
    ...(notStored.length === 0
      ? []
      : [
          Section({
            children: [
              table(
                ["variant", "case", "reason"],
                notStored.map(([output, reason]) => [output.variant, output.case, reason]),
              ),
            ],
            title: "Outputs not stored",
          }),
        ]),
  ];
};

const listed = (title: string, scored: readonly Scored[]) =>
  scored.length === 0
    ? []
    : [
        Section({
          children: [
            Table({
              columns: ["observation", "verdict"],
              rows: scored.slice(0, Runs.LISTED_LIMIT).map((entry) => {
                const verdict = Verdicts.of(entry.observation);

                return [cell(Runs.observationLabel(entry)), cell(verdict, verdictTones[verdict])];
              }),
            }),
            ...(scored.length > Runs.LISTED_LIMIT
              ? [
                  Text({
                    text: `+${String(scored.length - Runs.LISTED_LIMIT)} more`,
                    tone: tones.neutral,
                  }),
                ]
              : []),
          ],
          title,
        }),
      ];

export const compare = (base: Run, head: Run): View => {
  const comparison = Runs.compare(head, base);
  const names = [...new Set(comparison.deltas.map((row) => row.variant))];

  return [
    header(head),
    Text({ text: `compared with run ${base.id}`, tone: tones.neutral }),
    ...(comparison.added.length === 0 && comparison.removed.length === 0
      ? []
      : [
          Text({
            text: `${String(comparison.added.length)} observations added, ${String(
              comparison.removed.length,
            )} removed since the baseline; the deltas use only the observations both runs have`,
            tone: tones.warn,
          }),
        ]),
    ...listed("Added", comparison.added),
    ...listed("Removed", comparison.removed),
    ...names.map((name) => {
      const regressions = comparison.regressions
        .filter((transition) => transition.variant === name)
        .map((transition) => transition.after);

      const fixes = comparison.fixes
        .filter((transition) => transition.variant === name)
        .map((transition) => transition.after);

      const pValue = Option.flatMap(
        Option.fromNullishOr(
          comparison.deltas.find((row) => row.variant === name && Option.isSome(row.pValue)),
        ),
        (row) => row.pValue,
      );

      return Section({
        children: [
          Text({
            text: `${String(regressions.length)} regressions, ${String(fixes.length)} fixes${Option.match(
              pValue,
              {
                onNone: () => "",
                onSome: (value) => ` · McNemar p = ${value.toFixed(DIGITS)}`,
              },
            )}`,
            tone: regressions.length > 0 ? tones.bad : tones.good,
          }),
          Row({
            children: [
              figure(Charts.delta(comparison, name)),
              figure(Charts.transitions(comparison, name)),
            ],
          }),
          ...(regressions.length === 0
            ? []
            : [Section({ children: [observationTable(regressions)], title: "Regressions" })]),
          ...(fixes.length === 0
            ? []
            : [Section({ children: [observationTable(fixes)], title: "Fixes" })]),
        ],
        title: name,
      });
    }),
  ];
};

export const dashboard = (run: Run, history: HistorySnapshot = emptyHistory): View => {
  const runs = [...history.recent.toReversed(), run];

  return [
    Tabs({
      tabs: [
        { children: summary(run, history), title: "Summary" },
        {
          children: [Row({ children: [figure(Charts.trend(runs))] })],
          title: "Trend",
        },
        {
          children: Charts.caseMap(runs, { onlyUnstable: true }).map(figure),
          title: "Unstable cases",
        },
        { children: [figure(Charts.costVsAccuracy(run))], title: "Cost" },
        { children: [groupTable(run)], title: "Groups" },
      ],
    }),
  ];
};
