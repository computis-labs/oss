import { Resvg } from "@resvg/resvg-js";
import { Config, Effect, Option, Stdio, pipe } from "effect";
import terminalImage from "terminal-image";
import { parse, View } from "vega";
import { compile } from "vega-lite";
import type { TopLevelSpec } from "vega-lite";
import * as Charts from "./chart.ts";
import type { Chart, VegaLiteSpec } from "./chart.ts";
import { whenDefined } from "./object.ts";
import type { Theme } from "./theme.ts";
import { drawing, drawingKinds } from "./view.ts";
import type { ChartRenderer, Drawing } from "./view.ts";

export const protocols = {
  iterm: "iterm",
  kitty: "kitty",
  none: "none",
  terminalImage: "terminal-image",
} as const;

const ESCAPE = "\u001B";
const KITTY_CHUNK = 4096;
const PIXELS_PER_COLUMN = 9;
const MAX_COLUMNS = 120;
const BYTE_CHUNK = 0x80_00;

const optionalEnv = (name: string) =>
  Effect.orElseSucceed(Config.option(Config.String(name)), () => Option.none<string>());

export const detectProtocol = Effect.gen(function* detect() {
  const forced = yield* optionalEnv("EVAL_IMAGE_PROTOCOL");

  if (Option.isSome(forced)) {
    const wanted = Object.values(protocols).find((protocol) => protocol === forced.value);

    return wanted ?? protocols.none;
  }

  if (Option.isSome(yield* optionalEnv("CI"))) {
    return protocols.none;
  }

  const stdio = yield* Effect.serviceOption(Stdio.Stdio);
  const interactive = Option.isSome(stdio) && (yield* stdio.value.stdoutIsTerminal);

  if (!interactive) {
    return protocols.none;
  }

  const term = Option.getOrElse(yield* optionalEnv("TERM"), () => "");
  const program = Option.getOrElse(yield* optionalEnv("TERM_PROGRAM"), () => "");
  const lcTerminal = Option.getOrElse(yield* optionalEnv("LC_TERMINAL"), () => "");
  const kittyWindow = yield* optionalEnv("KITTY_WINDOW_ID");

  if (
    Option.isSome(kittyWindow) ||
    term === "xterm-kitty" ||
    term === "xterm-ghostty" ||
    term === "ghostty" ||
    program === "ghostty" ||
    program === "WezTerm"
  ) {
    return protocols.kitty;
  }

  if (program === "iTerm.app" || lcTerminal === "iTerm2") {
    return protocols.iterm;
  }

  return protocols.terminalImage;
});

export const toSvg = (spec: VegaLiteSpec) =>
  Effect.tryPromise(async () => {
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- SAFETY: Chart.toVegaLite only builds Vega-Lite v6 specs, and vega-lite validates the spec as it compiles it.
    const compiled = compile(spec as unknown as TopLevelSpec).spec;
    const view = new View(parse(compiled), { renderer: "none" });
    const svg = await view.toSVG();
    view.finalize();

    return svg;
  });

export const specOf = (charts: readonly Chart[], theme: Theme): VegaLiteSpec => {
  const specs = charts.map((chart) => Charts.toVegaLite(chart, theme));
  const [first] = specs;

  return specs.length === 1 && first !== undefined ? first : Charts.hconcat(specs, theme);
};

const base64 = (bytes: Uint8Array) =>
  btoa(
    Array.from({ length: Math.ceil(bytes.length / BYTE_CHUNK) }, (_, index) =>
      String.fromCodePoint(...bytes.subarray(index * BYTE_CHUNK, (index + 1) * BYTE_CHUNK)),
    ).join(""),
  );

export const svg = (): ChartRenderer => (charts, options) =>
  toSvg(specOf(charts, options.theme)).pipe(
    Effect.map((svgText) => Option.some(drawing(drawingKinds.html, svgText))),
    Effect.catchCause((cause) =>
      Effect.logWarning("The chart cannot be drawn as SVG.", cause).pipe(Effect.as(Option.none())),
    ),
  );

export const terminal =
  (
    options: {
      readonly protocol?: (typeof protocols)[keyof typeof protocols];
      readonly fonts?: { readonly files?: readonly string[]; readonly family?: string };
    } = {},
  ): ChartRenderer =>
  (charts, render) =>
    Effect.gen(function* drawInline() {
      const protocol = options.protocol ?? (yield* detectProtocol);

      if (protocol === protocols.none) {
        return Option.none<Drawing>();
      }

      const columns = Math.min(render.width, MAX_COLUMNS);

      const png = yield* pipe(
        toSvg(specOf(charts, render.theme)),
        Effect.flatMap((drawn) =>
          Effect.try(() =>
            new Resvg(drawn, {
              fitTo: { mode: "width", value: columns * PIXELS_PER_COLUMN },
              font: {
                loadSystemFonts: true,
                ...whenDefined(options.fonts?.files, (files) => ({ fontFiles: [...files] })),
                ...whenDefined(options.fonts?.family, (family) => ({ defaultFontFamily: family })),
              },
            })
              .render()
              .asPng(),
          ),
        ),
      );

      if (protocol === protocols.kitty) {
        const data = base64(png);

        const chunks = Array.from({ length: Math.ceil(data.length / KITTY_CHUNK) }, (_, index) =>
          data.slice(index * KITTY_CHUNK, (index + 1) * KITTY_CHUNK),
        );

        return Option.some(
          drawing(
            drawingKinds.terminal,
            chunks
              .map((chunk, index) => {
                const more = index < chunks.length - 1 ? 1 : 0;

                const control =
                  index === 0
                    ? `f=100,a=T,c=${String(columns)},m=${String(more)}`
                    : `m=${String(more)}`;

                return `${ESCAPE}_G${control};${chunk}${ESCAPE}\\`;
              })
              .join(""),
          ),
        );
      }

      if (protocol === protocols.iterm) {
        return Option.some(
          drawing(
            drawingKinds.terminal,
            `${ESCAPE}]1337;File=inline=1;width=${String(columns)};size=${String(png.length)}:${base64(png)}\u0007`,
          ),
        );
      }

      return Option.some(
        drawing(
          drawingKinds.terminal,
          yield* Effect.tryPromise(async () => await terminalImage.buffer(png, { width: columns })),
        ),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("The chart cannot be drawn in the terminal.", cause).pipe(
          Effect.as(Option.none<Drawing>()),
        ),
      ),
    );
