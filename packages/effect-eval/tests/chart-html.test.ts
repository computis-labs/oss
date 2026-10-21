import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import * as Charts from "../src/chart.ts";
import * as ChartHtml from "../src/chart-html.ts";
import * as Theme from "../src/theme.ts";
import * as View from "../src/view.ts";

const chart = Charts.Variants({
  bars: [{ high: Option.none(), low: Option.none(), value: 0.8, variant: "</script><b>x</b>" }],
  metric: "accuracy",
  title: "accuracy by variant",
});

const draw = (
  charts: readonly Charts.Chart[],
  options: { readonly includeScripts?: boolean } = {},
) =>
  ChartHtml.renderer(options)(charts, {
    accepts: [View.drawingKinds.html],
    theme: Theme.computis,
    width: 100,
  }).pipe(Effect.map(Option.match({ onNone: () => "", onSome: (drawn) => drawn.content })));

describe("ChartHtml.renderer", () => {
  it.effect("embeds the Vega-Lite spec with vegaEmbed in a div of its own", () =>
    Effect.gen(function* () {
      const html = yield* draw([chart]);
      const id = /<div id="(?<id>[^"]+)"><\/div>/u.exec(html)?.groups?.["id"];

      expect(id).toMatch(/^effect-eval-chart-/u);
      expect(html).toContain(`vegaEmbed("#${id ?? ""}"`);
      expect(html).toContain('"title":"accuracy by variant"');
    }),
  );

  it.effect("loads the Vega scripts unless told not to", () =>
    Effect.gen(function* () {
      expect(yield* draw([chart])).toContain(ChartHtml.scripts);
      expect(yield* draw([chart], { includeScripts: false })).not.toContain(ChartHtml.scripts);
    }),
  );

  it.effect("cannot close the script tag from inside the data", () =>
    Effect.gen(function* () {
      const html = yield* draw([chart], { includeScripts: false });

      expect(html.match(/<\/script>/gu)).toHaveLength(1);
      expect(html).toContain(String.raw`\u003c/script\u003e\u003cb\u003ex\u003c/b\u003e`);
    }),
  );

  it.effect("puts several charts side by side", () =>
    Effect.gen(function* () {
      const html = yield* draw([chart, chart], { includeScripts: false });

      expect(html).toContain('"hconcat":[');
    }),
  );
});
