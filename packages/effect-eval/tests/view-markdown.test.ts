import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import * as Charts from "../src/chart.ts";
import * as ChartHtml from "../src/chart-html.ts";
import * as ChartMermaid from "../src/chart-mermaid.ts";
import * as ChartUnicode from "../src/chart-unicode.ts";
import { tones } from "../src/theme.ts";
import * as View from "../src/view.ts";
import * as ViewHtml from "../src/view-html.ts";
import * as ViewMarkdown from "../src/view-markdown.ts";
import * as ViewText from "../src/view-text.ts";
import { sampleRuns } from "./fixtures.ts";

const chart = Charts.Variants({
  bars: [{ high: Option.none(), low: Option.none(), value: 0.8, variant: "small" }],
  metric: "accuracy",
  title: "accuracy by variant",
});

describe("ViewMarkdown.table", () => {
  it("escapes pipes and newlines and marks tones with an emoji", () => {
    expect(
      ViewMarkdown.table({
        columns: ["case", "verdict"],
        rows: [[View.cell("a|b\nc"), View.cell("wrong", tones.bad)]],
      }),
    ).toBe(["| case | verdict |", "| --- | --- |", "| a\\|b c | ❌ wrong |"].join("\n"));
  });
});

describe("ViewMarkdown.render", () => {
  it.effect("turns sections into headings one level deeper each", () =>
    Effect.gen(function* () {
      const markdown = yield* ViewMarkdown.render([
        View.Section({
          children: [
            View.Section({
              children: [View.Text({ text: "ok", tone: tones.good })],
              title: "Inner",
            }),
          ],
          title: "Outer",
        }),
      ]);

      expect(markdown).toBe("## Outer\n\n### Inner\n\n✅ ok\n");
    }),
  );

  it.effect("writes a figure as a table without a renderer and as a mermaid chart with one", () =>
    Effect.gen(function* () {
      const fallback = yield* ViewMarkdown.render([View.figure(chart)]);
      const drawn = yield* ViewMarkdown.render([View.figure(chart)], {
        renderer: ChartMermaid.renderer(),
      });

      expect(fallback).toBe(
        [
          "| variant | value | low | high |",
          "| --- | --- | --- | --- |",
          "| small | 0.800 | — | — |",
          "",
        ].join("\n"),
      );
      expect(drawn.startsWith("```mermaid\nxychart-beta\n")).toBe(true);
    }),
  );

  it.effect("takes from one shared renderer the drawing each target can show", () =>
    Effect.gen(function* () {
      const shared = View.firstOf(
        ChartHtml.renderer({ includeScripts: false }),
        ChartMermaid.renderer(),
        ChartUnicode.renderer(),
      );
      const view = [View.figure(chart)];

      const markdown = yield* ViewMarkdown.render(view, { renderer: shared });
      const html = yield* ViewHtml.render(view, { renderer: shared, title: "run" });
      const text = yield* ViewText.render(view, { color: false, renderer: shared, width: 80 });
      const unicodeInMarkdown = yield* ViewMarkdown.render(view, {
        renderer: ChartUnicode.renderer(),
      });
      const colouredInHtml = yield* ViewHtml.render(view, {
        renderer: ChartUnicode.renderer({ color: true }),
        title: "run",
      });

      expect(markdown.startsWith("```mermaid\n")).toBe(true);
      expect(html).toContain("<script>vegaEmbed(");
      expect(text).not.toContain("vegaEmbed");
      expect(text).not.toContain("mermaid");
      expect(text).toContain("█");
      expect(unicodeInMarkdown.startsWith("```\naccuracy by variant")).toBe(true);
      expect(colouredInHtml).not.toContain("\u001B");
      expect(colouredInHtml).toContain("<td>small</td>");
    }),
  );

  it.effect("keeps a text drawing in a fence its backticks cannot close", () =>
    Effect.gen(function* () {
      const forged = Charts.Variants({
        bars: [
          { high: Option.none(), low: Option.none(), value: 0.5, variant: "model\n```\n## FORGED" },
        ],
        metric: "accuracy",
        title: "accuracy by variant",
      });

      const markdown = yield* ViewMarkdown.render(
        [View.figure(forged), View.Section({ children: [], title: "After" })],
        { renderer: ChartUnicode.renderer() },
      );
      const lines = markdown.split("\n");
      const opening = lines.findIndex((line) => line.startsWith("```"));
      const fence = lines[opening] ?? "";
      const closing = lines.findIndex((line, index) => index > opening && line === fence);

      expect(fence).toBe("````");
      expect(lines.slice(opening + 1, closing).join("\n")).toContain("## FORGED");
      expect(lines.slice(closing + 1)).toContain("## After");
      expect(
        [...lines.slice(0, opening), ...lines.slice(closing + 1)].filter((line) =>
          line.startsWith("## "),
        ),
      ).toEqual(["## After"]);
    }),
  );

  it.effect("keeps a hostile label inside the Mermaid block", () =>
    Effect.gen(function* () {
      const forged = Charts.Variants({
        bars: [
          {
            high: Option.none(),
            low: Option.none(),
            value: 0.5,
            variant: "model\n```\n## FORGED\n```mermaid\n",
          },
        ],
        metric: "accuracy",
        title: "accuracy by variant",
      });

      const markdown = yield* ViewMarkdown.render(
        [View.figure(forged), View.Section({ children: [], title: "After" })],
        { renderer: ChartMermaid.renderer() },
      );
      const lines = markdown.split("\n");
      const opening = lines.findIndex((line) => line.startsWith("```"));
      const fence = (lines[opening] ?? "").replace("mermaid", "");
      const closing = lines.findIndex((line, index) => index > opening && line === fence);

      expect(lines[opening]).toBe(`${fence}mermaid`);
      expect(lines.slice(opening + 1, closing).join("\n")).toContain("## FORGED");
      expect(
        [...lines.slice(0, opening), ...lines.slice(closing + 1)].filter((line) =>
          line.startsWith("## "),
        ),
      ).toEqual(["## After"]);
      expect(lines.slice(opening + 1, closing).filter((line) => line.includes("x-axis"))).toEqual([
        '  x-axis ["model ``` ## FORGED ```mermaid "]',
      ]);
    }),
  );

  it.effect("writes a badge in bold with its tone", () =>
    Effect.gen(function* () {
      expect(yield* ViewMarkdown.render([View.Badge({ label: "passed", tone: tones.good })])).toBe(
        "**✅ PASSED**\n",
      );
    }),
  );

  it.effect("writes the tabs of a dashboard as headings", () =>
    Effect.gen(function* () {
      const { head, history } = yield* sampleRuns;

      const markdown = yield* ViewMarkdown.render(View.dashboard(head, history));

      expect(markdown.split("\n").filter((line) => line.startsWith("## "))).toEqual([
        "## Summary",
        "## Trend",
        "## Unstable cases",
        "## Cost",
        "## Groups",
      ]);
    }),
  );
});
