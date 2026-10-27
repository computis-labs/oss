import { Effect, Option, Random } from "effect";
import * as Charts from "./chart.ts";
import { drawing, drawingKinds } from "./view.ts";
import type { ChartRenderer } from "./view.ts";

const VEGA = "https://cdn.jsdelivr.net/npm/vega@6";
const VEGA_LITE = "https://cdn.jsdelivr.net/npm/vega-lite@6";
const VEGA_EMBED = "https://cdn.jsdelivr.net/npm/vega-embed@7";
const UNSAFE_IN_SCRIPT = /[<>&\u2028\u2029]/gu;
const HEX = 16;
const ESCAPE_WIDTH = 4;

const scriptSafe = (json: string) =>
  json.replaceAll(
    UNSAFE_IN_SCRIPT,
    (character) =>
      `\\u${(character.codePointAt(0) ?? 0).toString(HEX).padStart(ESCAPE_WIDTH, "0")}`,
  );

const ID_RANGE = 36 ** 8;

export const scripts = `<script src="${VEGA}"></script><script src="${VEGA_LITE}"></script><script src="${VEGA_EMBED}"></script>`;

export const renderer =
  (options: { readonly includeScripts?: boolean } = {}): ChartRenderer =>
  (charts, render) =>
    Random.nextIntBetween(0, ID_RANGE).pipe(
      Effect.map((random) => {
        const id = `effect-eval-chart-${random.toString(36)}`;
        const specs = charts.map((chart) => Charts.toVegaLite(chart, render.theme));
        const [first] = specs;

        const spec =
          specs.length === 1 && first !== undefined ? first : Charts.hconcat(specs, render.theme);

        return Option.some(
          drawing(
            drawingKinds.html,
            `${options.includeScripts === false ? "" : scripts}<div id="${id}"></div><script>vegaEmbed(${scriptSafe(JSON.stringify(`#${id}`))}, ${scriptSafe(JSON.stringify(spec))}, { actions: false });</script>`,
          ),
        );
      }),
    );
