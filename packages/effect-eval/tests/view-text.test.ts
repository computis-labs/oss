import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import * as Charts from "../src/chart.ts";
import * as ChartUnicode from "../src/chart-unicode.ts";
import { tones } from "../src/theme.ts";
import * as View from "../src/view.ts";
import * as ViewText from "../src/view-text.ts";
import { sampleRuns } from "./fixtures.ts";

const ESCAPE = "\u001B[";

const chart = Charts.Variants({
  bars: [{ high: Option.none(), low: Option.none(), value: 0.8, variant: "small" }],
  metric: "accuracy",
  title: "accuracy by variant",
});

const sideBySide = View.Row({
  children: [
    View.table(["metric", "value"], [["accuracy", "0.800"]]),
    View.table(["count", "n"], [["wrong", "2"]]),
  ],
});

describe("ViewText.render", () => {
  it.effect("puts the blocks of a row side by side when they fit", () =>
    Effect.gen(function* () {
      const text = yield* ViewText.render([sideBySide], { color: false, width: 80 });

      expect(text).toBe(["metric    value  count  n", "accuracy  0.800  wrong  2", ""].join("\n"));
    }),
  );

  it.effect("folds a row into a column when it does not fit the width", () =>
    Effect.gen(function* () {
      const text = yield* ViewText.render([sideBySide], { color: false, width: 20 });

      expect(text).toBe(
        ["metric    value", "accuracy  0.800", "count  n", "wrong  2", ""].join("\n"),
      );
    }),
  );

  it.effect("falls back to the table of a figure when the renderer cannot draw it", () =>
    Effect.gen(function* () {
      const text = yield* ViewText.render([View.figure(chart)], {
        color: false,
        renderer: View.unsupported,
        width: 80,
      });

      expect(text).toBe(["variant  value  low  high", "small    0.800  —    —", ""].join("\n"));
    }),
  );

  it.effect("draws a figure with the renderer it receives", () =>
    Effect.gen(function* () {
      const text = yield* ViewText.render([View.figure(chart)], {
        color: false,
        renderer: ChartUnicode.renderer(),
        width: 80,
      });

      expect(text.split("\n")[0]).toBe("accuracy by variant");
    }),
  );

  it.effect("cuts a long cell with an ellipsis", () =>
    Effect.gen(function* () {
      const text = yield* ViewText.render([View.table(["note"], [["x".repeat(60)]])], {
        color: false,
        width: 120,
      });

      expect(text.split("\n")[1]).toBe(`${"x".repeat(47)}…`);
    }),
  );

  it.effect("paints tones and titles only with color", () =>
    Effect.gen(function* () {
      const view = [
        View.Section({
          children: [View.Badge({ label: "failed", tone: tones.bad })],
          title: "Gates",
        }),
      ];

      const plain = yield* ViewText.render(view, { color: false, width: 80 });
      const colored = yield* ViewText.render(view, { color: true, width: 80 });

      expect(plain).toBe("Gates\n[ FAILED ]\n");
      expect(colored).toBe("\u001B[1mGates\u001B[0m\n\u001B[31m[ FAILED ]\u001B[0m\n");
    }),
  );

  it.effect("renders a whole summary within the width without color", () =>
    Effect.gen(function* () {
      const { head, history } = yield* sampleRuns;

      const text = yield* ViewText.render(View.summary(head, history), {
        color: false,
        width: 100,
      });

      expect(text.includes(ESCAPE)).toBe(false);
      expect(Math.max(...text.split("\n").map(ViewText.visibleLength))).toBeLessThanOrEqual(100);
      expect(text).toContain("[ FAILED ]");
    }),
  );
});

describe("ViewText.visibleLength", () => {
  it("ignores escape codes and counts code points", () => {
    expect(ViewText.visibleLength("\u001B[32mperché ✅\u001B[0m")).toBe(8);
  });
});
