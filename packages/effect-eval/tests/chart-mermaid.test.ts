import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, pipe } from "effect";
import * as Charts from "../src/chart.ts";
import * as ChartMermaid from "../src/chart-mermaid.ts";
import * as Theme from "../src/theme.ts";
import * as View from "../src/view.ts";
import { everyChart } from "./fixtures.ts";

const draw = (charts: readonly Charts.Chart[]) =>
  ChartMermaid.renderer()(charts, {
    accepts: [View.drawingKinds.markdown],
    theme: Theme.computis,
    width: 100,
  });

const point = (run: string, variant: string, value: number) => ({
  high: Option.none(),
  label: run,
  low: Option.none(),
  run,
  value,
  variant,
});

const variants = Charts.Variants({
  bars: [
    { high: Option.none(), low: Option.none(), value: 0.8, variant: "small" },
    { high: Option.none(), low: Option.none(), value: 0.95, variant: 'large "v2"' },
  ],
  metric: "accuracy",
  title: "accuracy by variant",
});

describe("ChartMermaid.renderer", () => {
  it.effect("draws a variants chart as a mermaid xychart bar", () =>
    Effect.gen(function* () {
      const drawn = yield* draw([variants]);

      expect(drawn).toEqual(
        Option.some({
          content: [
            "```mermaid",
            "xychart-beta",
            '  title "accuracy by variant"',
            '  x-axis ["small", "large \'v2\'"]',
            '  y-axis "accuracy" 0 --> 1',
            "  bar [0.800, 0.950]",
            "```",
          ].join("\n"),
          kind: "markdown",
        }),
      );
    }),
  );

  it.effect("draws one titled chart per variant on a trend, so every model keeps its name", () =>
    Effect.gen(function* () {
      const drawn = yield* draw([
        Charts.Trend({
          metric: "accuracy",
          points: [
            {
              high: Option.none(),
              label: "d1",
              low: Option.none(),
              run: "r1",
              value: 0.5,
              variant: "model-a",
            },
            {
              high: Option.none(),
              label: "d2",
              low: Option.none(),
              run: "r2",
              value: 0.7,
              variant: "model-a",
            },
            {
              high: Option.none(),
              label: "d2",
              low: Option.none(),
              run: "r2",
              value: 0.9,
              variant: "model-b",
            },
            {
              high: Option.none(),
              label: "d1",
              low: Option.none(),
              run: "r1",
              value: 0.6,
              variant: "model-b",
            },
          ],
          title: "accuracy over time",
        }),
      ]);

      expect(
        Option.match(drawn, { onNone: () => "", onSome: ({ content }) => content })
          .split("\n")
          .filter((line) => line.includes("title") || line.includes("line")),
      ).toEqual([
        '  title "accuracy over time · model-a"',
        "  line [0.500, 0.700]",
        '  title "accuracy over time · model-b"',
        "  line [0.600, 0.900]",
      ]);
    }),
  );

  it.effect("draws nothing for a trend with a gap, so the table shows only measured points", () =>
    Effect.gen(function* () {
      const drawn = yield* draw([
        Charts.Trend({
          metric: "accuracy",
          points: [point("r1", "old", 0.9), point("r2", "new", 0.9)],
          title: "accuracy over time",
        }),
      ]);

      expect(drawn).toEqual(Option.none());
    }),
  );

  it.effect("draws nothing for the kinds mermaid has no chart for", () =>
    Effect.gen(function* () {
      const charts = yield* everyChart;
      const unsupported = charts.filter(
        (chart) =>
          Charts.$is("CaseMap")(chart) ||
          Charts.$is("Transitions")(chart) ||
          Charts.$is("CostVsAccuracy")(chart),
      );

      const drawn = yield* pipe(
        unsupported,
        Effect.forEach((chart) => draw([chart])),
      );

      expect(drawn).toEqual([Option.none(), Option.none(), Option.none()]);
    }),
  );

  it.effect(
    "draws nothing when one of the charts is unsupported, so the fallback table shows",
    () =>
      Effect.gen(function* () {
        const drawn = yield* draw([
          variants,
          Charts.Transitions({ cells: [], title: "verdicts from the baseline to this run" }),
        ]);

        expect(drawn).toEqual(Option.none());
      }),
  );

  it.effect("draws nothing for a chart without data", () =>
    Effect.gen(function* () {
      expect(yield* draw([Charts.Delta({ rows: [], title: "no change" })])).toEqual(Option.none());
    }),
  );
});
