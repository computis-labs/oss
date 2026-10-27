import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, pipe } from "effect";
import * as Charts from "../src/chart.ts";
import * as ChartUnicode from "../src/chart-unicode.ts";
import * as Theme from "../src/theme.ts";
import * as View from "../src/view.ts";
import { verdicts } from "../src/verdict.ts";
import { everyChart, sampleRuns } from "./fixtures.ts";

const ESCAPE = "\u001B[";

const draw = (charts: readonly Charts.Chart[], options: { readonly color?: boolean } = {}) =>
  ChartUnicode.renderer(options)(charts, {
    accepts: [View.drawingKinds.text, View.drawingKinds.terminal],
    theme: Theme.computis,
    width: 100,
  }).pipe(Effect.map(Option.match({ onNone: () => "", onSome: (drawn) => drawn.content })));

const interval = (value: number, low: number, high: number) => ({
  high: Option.some(high),
  low: Option.some(low),
  value,
});

describe("ChartUnicode.renderer case map colours", () => {
  it.effect("paints every verdict in its own colour", () =>
    Effect.gen(function* () {
      const everyVerdict = Object.values(verdicts);

      const text = yield* draw(
        [
          Charts.CaseMap({
            cells: everyVerdict.map((verdict) => ({ column: "r1", row: verdict, verdict })),
            columns: [{ id: "r1", label: "run" }],
            rows: everyVerdict,
            title: "every verdict",
            variant: "default",
          }),
        ],
        { color: true },
      );

      const codes = text
        .split("\n")
        .slice(2, 2 + everyVerdict.length)
        .map((line) => line.split(ESCAPE).at(-2)?.split("m")[0]);

      expect(codes.filter((code) => code === undefined)).toEqual([]);
      expect(new Set(codes).size).toBe(everyVerdict.length);
    }),
  );
});

describe("ChartUnicode.renderer", () => {
  it.effect("draws every chart kind under its title", () =>
    Effect.gen(function* () {
      const charts = yield* everyChart;

      const drawn = yield* pipe(
        charts,
        Effect.forEach((chart) => draw([chart])),
      );

      expect(drawn.map((text, index) => text.includes(charts[index]?.title ?? "missing"))).toEqual(
        charts.map(() => true),
      );
    }),
  );

  it.effect("draws a bar per variant with its value and interval", () =>
    Effect.gen(function* () {
      const text = yield* draw([
        Charts.Variants({
          bars: [
            { ...interval(0.75, 0.5, 0.9), variant: "small" },
            { ...interval(1, 1, 1), variant: "large" },
          ],
          metric: "accuracy",
          title: "accuracy by variant",
        }),
      ]);

      expect(text.split("\n")).toEqual([
        "accuracy by variant",
        expect.stringMatching(/^small\s+█+─+░+ 0\.750 \[0\.500, 0\.900\]$/u),
        expect.stringMatching(/^large\s+█+ 1\.000 \[1\.000, 1\.000\]$/u),
      ]);
    }),
  );

  it.effect("writes no escape codes without color and paints with color", () =>
    Effect.gen(function* () {
      const charts = yield* everyChart;

      const plain = yield* draw(charts);
      const colored = yield* draw(charts, { color: true });

      expect(plain.includes(ESCAPE)).toBe(false);
      expect(colored.includes(ESCAPE)).toBe(true);
    }),
  );

  it.effect("marks each case of the case map with the glyph of its verdict", () =>
    Effect.gen(function* () {
      const text = yield* draw([
        Charts.CaseMap({
          cells: [
            { column: "r1", row: "m1", verdict: "right" },
            { column: "r2", row: "m1", verdict: "wrong" },
            { column: "r1", row: "m2", verdict: "missed" },
          ],
          columns: [
            { id: "r1", label: "2025-01-01 0123456" },
            { id: "r2", label: "2025-01-01 0123456" },
          ],
          rows: ["m1", "m2"],
          title: "cases across runs",
          variant: "default",
        }),
      ]);

      expect(
        text
          .split("\n")
          .slice(0, 4)
          .map((line) => line.trimEnd().slice(-2)),
      ).toEqual(["ns", "12", "█X", "M·"]);
    }),
  );

  it.effect("names the columns and keeps every verdict apart", () =>
    Effect.gen(function* () {
      const text = yield* draw([
        Charts.CaseMap({
          cells: [
            { column: "r1", row: "a", verdict: "gap" },
            { column: "r2", row: "a", verdict: "excluded" },
            { column: "r1", row: "b", verdict: "unscored" },
          ],
          columns: [
            { id: "r1", label: "baseline #1" },
            { id: "r2", label: "head #2" },
          ],
          rows: ["a", "b"],
          title: "cases across runs",
          variant: "default",
        }),
      ]);

      const lines = text.split("\n").map((line) => line.trimEnd());

      expect(lines.slice(1, 4).map((line) => line.slice(-2))).toEqual(["12", "G~", "?·"]);
      expect(lines).toContain("1 baseline #1");
      expect(lines).toContain("2 head #2");
      expect(lines.at(-1)).toBe("G gap  ~ excluded  ? unscored  · no run");
    }),
  );

  it.effect("signs each delta in points", () =>
    Effect.gen(function* () {
      const text = yield* draw([
        Charts.Delta({
          rows: [
            { high: Option.none(), low: Option.none(), metric: "accuracy", value: -0.125 },
            { high: Option.none(), low: Option.none(), metric: "recall", value: 0.25 },
          ],
          title: "head against base",
        }),
      ]);

      expect(text).toMatch(/accuracy .* -12\.5 pt/u);
      expect(text).toMatch(/recall .* \+25\.0 pt/u);
    }),
  );

  it.effect("writes the interval of a delta next to it", () =>
    Effect.gen(function* () {
      const text = yield* draw([
        Charts.Delta({
          rows: [{ high: Option.some(0.5), low: Option.some(0.1), metric: "accuracy", value: 0.3 }],
          title: "head against base",
        }),
      ]);

      expect(text).toMatch(/accuracy .* \+30\.0 pt \[\+10\.0, \+50\.0\]/u);
    }),
  );

  it.effect("lists the points of a trend with a single run instead of plotting it", () =>
    Effect.gen(function* () {
      const { head } = yield* sampleRuns;

      const text = yield* draw([Charts.trend([head])]);

      expect(text.split("\n")).toEqual([
        "accuracy over time",
        expect.stringMatching(/^small\s+0\.500 \[/u),
        expect.stringMatching(/^large\s+1\.000 \[/u),
      ]);
    }),
  );
});
