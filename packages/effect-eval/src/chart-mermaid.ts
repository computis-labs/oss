import { Effect, Option } from "effect";
import * as Charts from "./chart.ts";
import { fenced } from "./text.ts";
import { drawing, drawingKinds } from "./view.ts";
import type { ChartRenderer } from "./view.ts";

const LINE_BREAK = "\n";
const DIGITS = 3;
const QUOTE = /"/gu;
const BREAKS = /\r?\n|\r/gu;
const MERMAID = "mermaid";

const quoted = (text: string) => `"${text.replaceAll(QUOTE, "'").replaceAll(BREAKS, " ")}"`;

const axis = (labels: readonly string[]) => `[${labels.map(quoted).join(", ")}]`;

const values = (numbers: readonly number[]) =>
  `[${numbers.map((number) => number.toFixed(DIGITS)).join(", ")}]`;

const block = (lines: readonly string[]) =>
  fenced(["xychart-beta", ...lines].join(LINE_BREAK), MERMAID);

export const renderer = (): ChartRenderer => (charts) =>
  Effect.succeed(
    Option.all(
      charts.map((chart): Option.Option<string> =>
        Charts.$match(chart, {
          CaseMap: () => Option.none(),
          CostVsAccuracy: () => Option.none(),
          Delta: ({ rows, title }) =>
            rows.length === 0
              ? Option.none()
              : Option.some(
                  block([
                    `  title ${quoted(title)}`,
                    `  x-axis ${axis(rows.map((row) => row.metric))}`,
                    `  y-axis "delta"`,
                    `  bar ${values(rows.map((row) => row.value))}`,
                  ]),
                ),
          Transitions: () => Option.none(),
          Trend: ({ metric, points, title }) => {
            const columns = Charts.trendColumns(points);
            const variants = [...new Set(points.map((point) => point.variant))];

            if (columns.length === 0) {
              return Option.none();
            }

            return Option.map(
              Option.all(
                variants.map((variant) =>
                  Option.all(
                    columns.map((column) =>
                      Option.map(
                        Option.fromNullishOr(
                          points.find(
                            (point) => point.variant === variant && point.run === column.id,
                          ),
                        ),
                        (point) => point.value,
                      ),
                    ),
                  ),
                ),
              ),
              (series) =>
                series
                  .map((line, index) =>
                    block([
                      `  title ${quoted(`${title} · ${variants[index] ?? ""}`)}`,
                      `  x-axis ${axis(columns.map((column) => column.label))}`,
                      `  y-axis ${quoted(metric)} 0 --> 1`,
                      `  line ${values(line)}`,
                    ]),
                  )
                  .join(`${LINE_BREAK}${LINE_BREAK}`),
            );
          },
          Variants: ({ bars, metric, title }) =>
            bars.length === 0
              ? Option.none()
              : Option.some(
                  block([
                    `  title ${quoted(title)}`,
                    `  x-axis ${axis(bars.map((bar) => bar.variant))}`,
                    `  y-axis ${quoted(metric)} 0 --> 1`,
                    `  bar ${values(bars.map((bar) => bar.value))}`,
                  ]),
                ),
        }),
      ),
    ).pipe(
      Option.map((drawn) =>
        drawing(drawingKinds.markdown, drawn.join(`${LINE_BREAK}${LINE_BREAK}`)),
      ),
    ),
  );
