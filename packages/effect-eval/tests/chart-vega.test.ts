import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Logger, Option, Schema, Stdio, pipe } from "effect";
import * as Charts from "../src/chart.ts";
import * as ChartVega from "../src/chart-vega.ts";
import * as Dataset from "../src/dataset.ts";
import * as Eval from "../src/eval.ts";
import * as Run from "../src/run.ts";
import * as Runner from "../src/runner.ts";
import * as Scorer from "../src/scorer.ts";
import * as Theme from "../src/theme.ts";
import { verdicts } from "../src/verdict.ts";
import * as View from "../src/view.ts";
import { everyChart } from "./fixtures.ts";

const withEnvironment = (env: Record<string, string>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

const render = {
  accepts: [View.drawingKinds.html, View.drawingKinds.terminal],
  theme: Theme.computis,
  width: 40,
};
const contentOf = Option.match({
  onNone: () => "",
  onSome: (drawn: View.Drawing) => drawn.content,
});

describe("ChartVega.toSvg", () => {
  it.effect("compiles and draws every chart kind", () =>
    Effect.gen(function* () {
      const charts = yield* everyChart;

      const drawn = yield* pipe(
        charts,
        Effect.forEach((chart) => ChartVega.toSvg(Charts.toVegaLite(chart, Theme.computis))),
      );

      expect(drawn.map((svg) => svg.startsWith("<svg"))).toEqual(charts.map(() => true));
      expect(drawn.map((svg, index) => svg.includes(charts[index]?.title ?? "missing"))).toEqual(
        charts.map(() => true),
      );
    }),
  );

  it.effect("draws several charts side by side in one SVG", () =>
    Effect.gen(function* () {
      const charts = yield* everyChart;

      const svg = yield* ChartVega.toSvg(ChartVega.specOf(charts, Theme.computis));

      expect(svg.match(/<svg/gu)).toHaveLength(1);
    }),
  );
});

const ColorScaleSchema = Schema.Struct({
  encoding: Schema.Struct({
    color: Schema.Struct({
      scale: Schema.Struct({
        domain: Schema.Array(Schema.String),
        range: Schema.Array(Schema.String),
      }),
    }),
  }),
});

const everyVerdict = Object.values(verdicts);

const verdictMap = Charts.CaseMap({
  cells: everyVerdict.map((verdict) => ({ column: "r1", row: verdict, verdict })),
  columns: [{ id: "r1", label: "run" }],
  rows: everyVerdict,
  title: "every verdict",
  variant: "default",
});

describe("ChartVega case map colours", () => {
  it.effect("gives every verdict a colour of the theme and fills every cell with it", () =>
    Effect.gen(function* () {
      const spec = Charts.toVegaLite(verdictMap, Theme.computis);
      const { scale } = (yield* Schema.decodeUnknownEffect(ColorScaleSchema)(spec)).encoding.color;

      const svg = yield* ChartVega.toSvg(spec);

      expect(everyVerdict.filter((verdict) => !scale.domain.includes(verdict))).toEqual([]);
      expect(scale.range).toHaveLength(scale.domain.length);
      expect(
        scale.range.filter(
          (colour) => !svg.toLowerCase().includes(`fill="${colour.toLowerCase()}"`),
        ),
      ).toEqual([]);
    }),
  );
});

describe("ChartVega.svg", () => {
  it.effect("renders the charts as one SVG", () =>
    Effect.gen(function* () {
      const charts = yield* everyChart;

      const drawn = yield* ChartVega.svg()(charts.slice(0, 2), render);

      expect(drawn.pipe(Option.map((svg) => svg.kind))).toEqual(
        Option.some(View.drawingKinds.html),
      );
      expect(contentOf(drawn).startsWith("<svg")).toBe(true);
    }),
  );
});

describe("ChartVega warnings of a sensitive run", () => {
  it.effect("draw from charts that hold no output, detail or failure of the run", () =>
    Effect.gen(function* () {
      const secret = "CUSTOMER-SECRET-123";
      const run = yield* Runner.run(
        Eval.make({
          dataset: Dataset.fromIterable(["a", "b"], { id: (id: string) => id }),
          name: "secret",
          output: Schema.String,
          score: Scorer.label<string, string>({
            actual: Option.some,
            expected: () => Scorer.present("x"),
          }),
          sensitive: true,
          task: (input) =>
            input.id === "a" ? Effect.succeed(secret) : Effect.fail(`failed on ${secret}`),
        }),
      );
      const comparison = Run.compare(run, run);
      const logged: string[] = [];

      const charts = [
        Charts.trend([run, run]),
        Charts.variants(run),
        Charts.delta(comparison, "small"),
        Charts.transitions(comparison, "small"),
        ...Charts.caseMap([run, run]),
        Charts.costVsAccuracy(run),
      ];
      yield* ChartVega.svg()(charts, render).pipe(
        Effect.provide(
          Logger.layer([Logger.formatLogFmt.pipe(Logger.map((line) => logged.push(line)))]),
        ),
      );

      expect(JSON.stringify(run.outputs)).toContain(secret);
      expect(JSON.stringify(charts)).not.toContain(secret);
      expect(logged.join("\n")).not.toContain(secret);
    }),
  );
});

describe("ChartVega.terminal", () => {
  it.effect("draws nothing when the protocol is none", () =>
    Effect.gen(function* () {
      const charts = yield* everyChart;

      expect(
        yield* ChartVega.terminal({ protocol: ChartVega.protocols.none })(charts, render),
      ).toEqual(Option.none());
    }),
  );

  it.effect("sends the PNG in kitty graphics chunks", () =>
    Effect.gen(function* () {
      const charts = yield* everyChart;

      const drawn = yield* ChartVega.terminal({ protocol: ChartVega.protocols.kitty })(
        charts.slice(1, 2),
        render,
      );
      const text = contentOf(drawn);

      expect(text.startsWith("\u001B_Gf=100,a=T,c=40,")).toBe(true);
      expect(text.endsWith("\u001B\\")).toBe(true);
    }),
  );

  it.effect("sends the PNG inline with the iTerm protocol", () =>
    Effect.gen(function* () {
      const charts = yield* everyChart;

      const drawn = yield* ChartVega.terminal({ protocol: ChartVega.protocols.iterm })(
        charts.slice(1, 2),
        render,
      );

      expect(contentOf(drawn).startsWith("\u001B]1337;File=inline=1;width=40;")).toBe(true);
    }),
  );
});

describe("ChartVega.detectProtocol", () => {
  it.effect("draws no image on CI", () =>
    Effect.gen(function* () {
      expect(yield* ChartVega.detectProtocol).toBe(ChartVega.protocols.none);
    }).pipe(withEnvironment({ CI: "true", TERM: "xterm-kitty" })),
  );

  it.effect("draws no image when stdout is not a terminal, even in a graphics terminal", () =>
    Effect.gen(function* () {
      const redirected = yield* ChartVega.detectProtocol.pipe(
        withEnvironment({ TERM: "xterm-kitty" }),
        Effect.provide(Stdio.layerTest({ stdoutIsTerminal: Effect.succeed(false) })),
      );
      const unknown = yield* ChartVega.detectProtocol.pipe(
        withEnvironment({ TERM: "xterm-kitty" }),
      );

      expect([redirected, unknown]).toEqual([ChartVega.protocols.none, ChartVega.protocols.none]);
    }),
  );

  it.effect("uses kitty graphics in Ghostty and iTerm images in iTerm", () =>
    Effect.gen(function* () {
      const ghostty = yield* ChartVega.detectProtocol.pipe(
        withEnvironment({ TERM_PROGRAM: "ghostty" }),
      );
      const iterm = yield* ChartVega.detectProtocol.pipe(
        withEnvironment({ TERM_PROGRAM: "iTerm.app" }),
      );
      const other = yield* ChartVega.detectProtocol.pipe(
        withEnvironment({ TERM: "xterm-256color" }),
      );

      expect([ghostty, iterm, other]).toEqual([
        ChartVega.protocols.kitty,
        ChartVega.protocols.iterm,
        ChartVega.protocols.terminalImage,
      ]);
    }).pipe(Effect.provide(Stdio.layerTest({ stdoutIsTerminal: Effect.succeed(true) }))),
  );

  it.effect("follows EVAL_IMAGE_PROTOCOL and treats an unknown value as none", () =>
    Effect.gen(function* () {
      const forced = yield* ChartVega.detectProtocol.pipe(
        withEnvironment({ CI: "true", EVAL_IMAGE_PROTOCOL: "iterm" }),
      );
      const unknown = yield* ChartVega.detectProtocol.pipe(
        withEnvironment({ EVAL_IMAGE_PROTOCOL: "sixel" }),
      );

      expect([forced, unknown]).toEqual([ChartVega.protocols.iterm, ChartVega.protocols.none]);
    }),
  );
});
