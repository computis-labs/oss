import { Effect, Option } from "effect";
import { plot } from "simple-ascii-chart";
import type { Color } from "simple-ascii-chart";
import * as Charts from "./chart.ts";
import type { Chart, Interval } from "./chart.ts";
import { verdictClasses } from "./theme.ts";
import { verdicts } from "./verdict.ts";
import type { Verdict } from "./verdict.ts";
import { lookup, whenDefined } from "./object.ts";
import { codePoints } from "./text.ts";
import { drawing, drawingKinds } from "./view.ts";
import type { ChartRenderer } from "./view.ts";

const ESCAPE = "\u001B[";
const RESET = `${ESCAPE}0m`;
const FULL = "█";
const EMPTY = "░";
const WHISKER = "─";
const ZERO = "│";
const DIGITS = 3;
const LABEL_WIDTH = 24;
const MIN_BAR = 10;
const PLOT_HEIGHT = 10;
const LINE_BREAK = "\n";
const PERCENT = 100;

const seriesColors: readonly Color[] = [
  "ansiWhite",
  "ansiBlue",
  "ansiCyan",
  "ansiGreen",
  "ansiYellow",
  "ansiMagenta",
  "ansiRed",
];

const verdictCodes = {
  [verdicts.errored]: "34",
  [verdicts.excluded]: "90",
  [verdicts.gap]: "36",
  [verdicts.missed]: "35",
  [verdicts.partial]: "33",
  [verdicts.right]: "32",
  [verdicts.unscored]: "37",
  [verdicts.wrong]: "31",
} as const satisfies Record<Verdict, string>;

const verdictGlyphs = {
  [verdicts.right]: "█",
  [verdicts.partial]: "P",
  [verdicts.wrong]: "X",
  [verdicts.missed]: "M",
  [verdicts.errored]: "E",
  [verdicts.gap]: "G",
  [verdicts.excluded]: "~",
  [verdicts.unscored]: "?",
} as const satisfies Record<Verdict, string>;

const NO_RUN = "·";
const LEGEND_SEPARATOR = "  ";
const COLUMN_DIGITS = 10;

const label = (text: string) => {
  const characters = codePoints(text);

  return characters.length > LABEL_WIDTH
    ? `${characters.slice(0, LABEL_WIDTH - 1).join("")}…`
    : text.padEnd(LABEL_WIDTH);
};

const intervalText = (interval: Interval) =>
  `${interval.value.toFixed(DIGITS)}${Option.match(Option.all([interval.low, interval.high]), {
    onNone: () => "",
    onSome: ([low, high]) => ` [${low.toFixed(DIGITS)}, ${high.toFixed(DIGITS)}]`,
  })}`;

const signed = (value: number) => `${value > 0 ? "+" : ""}${(value * PERCENT).toFixed(1)}`;

export const renderer = (options: { readonly color?: boolean } = {}): ChartRenderer => {
  const paint = (text: string, code: string) =>
    options.color === true ? `${ESCAPE}${code}m${text}${RESET}` : text;

  const palette = (series: number) =>
    whenDefined(options.color === true ? series : undefined, (count) => ({
      color: Array.from(
        { length: count },
        (_, index): Color => seriesColors[index % seriesColors.length] ?? "ansiWhite",
      ),
    }));

  const bar = (interval: Interval, width: number) => {
    const at = (share: number) => Math.round(Math.min(1, Math.max(0, share)) * width);
    const filled = at(interval.value);
    const low = Option.match(interval.low, { onNone: () => filled, onSome: at });
    const high = Option.match(interval.high, { onNone: () => filled, onSome: at });

    return Array.from({ length: width }, (_, index) => {
      if (index < Math.min(filled, low)) {
        return FULL;
      }

      if (index < filled) {
        return FULL;
      }

      if (index >= low && index < high) {
        return WHISKER;
      }

      return EMPTY;
    }).join("");
  };

  const draw = (chart: Chart, width: number) => {
    const barWidth = Math.max(MIN_BAR, width - LABEL_WIDTH - 32);

    return Charts.$match(chart, {
      CaseMap: ({ cells, columns, rows, title }) => {
        const verdictAt = (row: string, column: string) =>
          Option.fromNullishOr(
            cells.find((cell) => cell.row === row && cell.column === column)?.verdict,
          );

        const grid = rows.map((row) => columns.map((column) => verdictAt(row, column.id)));
        const seen = new Set(grid.flat().flatMap((verdict) => Option.toArray(verdict)));

        const legend = [
          ...Object.entries(verdictGlyphs)
            .filter(([verdict]) => seen.has(verdict))
            .map(
              ([verdict, glyph]) =>
                `${paint(glyph, lookup(verdictCodes, verdict) ?? "2")} ${verdict}`,
            ),
          ...(grid.flat().some(Option.isNone) ? [`${NO_RUN} no run`] : []),
        ];

        return [
          title,
          `${label("")} ${columns.map((_, index) => String((index + 1) % COLUMN_DIGITS)).join("")}`,
          ...rows.map(
            (row, index) =>
              `${label(row)} ${(grid[index] ?? [])
                .map((verdict) =>
                  Option.match(verdict, {
                    onNone: () => paint(NO_RUN, "2"),
                    onSome: (found) =>
                      paint(
                        lookup(verdictGlyphs, found) ?? NO_RUN,
                        lookup(verdictCodes, found) ?? "2",
                      ),
                  }),
                )
                .join("")}`,
          ),
          ...columns.map((column, index) => `${String(index + 1)} ${column.label}`),
          legend.join(LEGEND_SEPARATOR),
        ].join(LINE_BREAK);
      },
      CostVsAccuracy: ({ points, title }) => {
        const priced = points.flatMap((point) =>
          Option.toArray(point.cost.pipe(Option.map((cost) => ({ cost, point })))),
        );

        return priced.length === 0
          ? title
          : plot(
              priced.map(({ cost, point }) => [[cost, point.value] as const]),
              {
                ...palette(priced.length),
                height: PLOT_HEIGHT,
                legend: { position: "right", series: priced.map(({ point }) => point.variant) },
                mode: "point",
                title,
                width: barWidth,
                xLabel: "cost (USD)",
                yLabel: "accuracy",
              },
            );
      },
      Delta: ({ rows, title }) => {
        const half = Math.floor(barWidth / 2);
        const largest = Math.max(1e-9, ...rows.map((row) => Math.abs(row.value)));

        return [
          title,
          ...rows.map((row) => {
            const size = Math.round((Math.abs(row.value) / largest) * half);

            const left =
              row.value < 0
                ? `${" ".repeat(half - size)}${paint(FULL.repeat(size), "31")}`
                : " ".repeat(half);

            const right = row.value > 0 ? paint(FULL.repeat(size), "32") : "";

            return `${label(row.metric)} ${left}${ZERO}${right}${" ".repeat(Math.max(0, half - (row.value > 0 ? size : 0)))} ${signed(row.value)} pt${Option.match(
              Option.all([row.low, row.high]),
              {
                onNone: () => "",
                onSome: ([low, high]) => ` [${signed(low)}, ${signed(high)}]`,
              },
            )}`;
          }),
        ].join(LINE_BREAK);
      },
      Transitions: ({ cells, title }) => {
        const classes = Object.values(verdictClasses);

        return [
          title,
          `${label("baseline \\ now")} ${classes.map((name) => name.padStart(8)).join("")}`,
          ...classes.map(
            (from) =>
              `${label(from)} ${classes
                .map((to) => {
                  const count =
                    cells.find((cell) => cell.from === from && cell.to === to)?.count ?? 0;

                  const text = String(count).padStart(8);

                  return count === 0 ? paint(text, "2") : text;
                })
                .join("")}`,
          ),
        ].join(LINE_BREAK);
      },
      Trend: ({ points, title }) => {
        const runs = Charts.trendColumns(points);
        const ids = runs.map((column) => column.id);
        const variants = [...new Set(points.map((point) => point.variant))];

        if (runs.length < 2) {
          return [
            title,
            ...points.map((point) => `${label(point.variant)} ${intervalText(point)}`),
          ].join(LINE_BREAK);
        }

        return plot(
          variants.map((variant) =>
            points
              .filter((point) => point.variant === variant)
              .map((point) => [ids.indexOf(point.run), point.value] as const),
          ),
          {
            ...palette(variants.length),
            formatter: (value, helpers) =>
              helpers.axis === "x" ? (runs[Math.round(value)]?.label ?? "") : value.toFixed(2),
            height: PLOT_HEIGHT,
            legend: { position: "right", series: variants },
            title,
            width: barWidth,
            yRange: [0, 1],
          },
        );
      },
      Variants: ({ bars, title }) =>
        [
          title,
          ...bars.map(
            (entry, index) =>
              `${label(entry.variant)} ${paint(bar(entry, barWidth), index === 0 ? "1" : "36")} ${intervalText(entry)}`,
          ),
        ].join(LINE_BREAK),
    });
  };

  return (charts, render) =>
    Effect.succeed(
      Option.some(
        drawing(
          options.color === true ? drawingKinds.terminal : drawingKinds.text,
          charts.map((chart) => draw(chart, render.width)).join(`${LINE_BREAK}${LINE_BREAK}`),
        ),
      ),
    );
};
