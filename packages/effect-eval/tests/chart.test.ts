import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import * as Charts from "../src/chart.ts";
import * as Json from "../src/json.ts";
import * as Run from "../src/run.ts";
import * as Theme from "../src/theme.ts";
import * as View from "../src/view.ts";
import { everyChart, runOf, sampleRuns, scoredAs } from "./fixtures.ts";

const scoredAt = (variant: string, trial: number, right: boolean) =>
  scoredAs({ right, trial, variant });

describe("Chart.trend", () => {
  it.effect("has one point per run and variant, oldest first", () =>
    Effect.gen(function* () {
      const { base, head } = yield* sampleRuns;

      const chart = Charts.trend([base, head]);

      expect(
        Charts.$is("Trend")(chart) ? chart.points.map((point) => [point.run, point.variant]) : [],
      ).toEqual([
        [base.id, "small"],
        [base.id, "large"],
        [head.id, "small"],
        [head.id, "large"],
      ]);
    }),
  );

  it.effect("labels a point with the date and the short sha", () =>
    Effect.gen(function* () {
      const { head } = yield* sampleRuns;

      expect(Charts.runLabel(head)).toMatch(/^\d{4}-\d{2}-\d{2} 0123456$/u);
    }),
  );

  it("places two runs with the same label at two x positions", () => {
    const chart = Charts.trend([
      runOf("run-a", [scoredAt("good", 1, true)], 1),
      runOf("run-b", [scoredAt("good", 1, false)], 1),
    ]);

    const spec = Charts.toVegaLite(chart, Theme.computis);
    const encoding = Json.isRecord(spec["encoding"]) ? spec["encoding"]["x"] : undefined;

    expect(encoding).toMatchObject({ field: "run", sort: ["run-a", "run-b"] });
  });
});

describe("Chart.variants", () => {
  it.effect("has a bar per variant with the accuracy and its interval", () =>
    Effect.gen(function* () {
      const { head } = yield* sampleRuns;

      const chart = Charts.variants(head);

      expect(Charts.$is("Variants")(chart) ? chart.bars : []).toMatchObject([
        { high: Option.some(expect.any(Number)), value: 0.5, variant: "small" },
        { value: 1, variant: "large" },
      ]);
    }),
  );
});

describe("Chart.caseMap", () => {
  it.effect("keeps only the cases whose verdict changed across runs when asked", () =>
    Effect.gen(function* () {
      const { base, head } = yield* sampleRuns;

      const [small, large] = Charts.caseMap([base, head], { onlyUnstable: true });

      expect(small !== undefined && Charts.$is("CaseMap")(small) ? small.rows : []).toEqual([
        "m1",
        "m2",
        "m3",
      ]);
      expect(large !== undefined && Charts.$is("CaseMap")(large) ? large.rows : []).toEqual([]);
    }),
  );

  it("gives every trial its own column and every variant its own map", () => {
    const run = runOf(
      "run-a",
      [
        scoredAt("good", 1, true),
        scoredAt("good", 2, false),
        scoredAt("bad", 1, false),
        scoredAt("bad", 2, false),
      ],
      2,
    );

    const maps = Charts.caseMap([run], { onlyUnstable: true });
    const fallbacks = maps.map((chart) =>
      View.chartTable(chart).rows.map((row) => row.map((entry) => entry.text)),
    );

    expect(maps.map((chart) => (Charts.$is("CaseMap")(chart) ? chart.variant : ""))).toEqual([
      "good",
      "bad",
    ]);
    expect(fallbacks).toEqual([[["a/a", "right", "wrong"]], []]);
  });

  it("keeps two runs with the same label apart", () => {
    const first = runOf("run-a", [scoredAt("good", 1, true)], 1);
    const second = runOf("run-b", [scoredAt("good", 1, false)], 1);

    const [map] = Charts.caseMap([first, second]);

    expect(Charts.runLabel(first)).toBe(Charts.runLabel(second));
    expect(map !== undefined && Charts.$is("CaseMap")(map) ? map.cells : []).toEqual([
      { column: "run-a#1", row: "a/a", verdict: "right" },
      { column: "run-b#1", row: "a/a", verdict: "wrong" },
    ]);
  });
});

describe("Chart.transitions", () => {
  it.effect("counts the pairs that moved from one verdict class to another", () =>
    Effect.gen(function* () {
      const { base, head } = yield* sampleRuns;

      const chart = Charts.transitions(Run.compare(head, base), "small");
      const cells = Charts.$is("Transitions")(chart) ? chart.cells : [];

      expect(cells.filter((cell) => cell.count > 0)).toEqual([
        { count: 2, from: "right", to: "right" },
        { count: 4, from: "right", to: "wrong" },
        { count: 2, from: "wrong", to: "right" },
      ]);
    }),
  );
});

describe("Chart.costVsAccuracy", () => {
  it.effect("puts each variant at its cost and accuracy", () =>
    Effect.gen(function* () {
      const { head } = yield* sampleRuns;

      const chart = Charts.costVsAccuracy(head);
      const points = Charts.$is("CostVsAccuracy")(chart) ? chart.points : [];

      expect(
        points.map((point) => [
          point.variant,
          point.cost.pipe(Option.map((cost) => cost.toFixed(3))),
          point.value,
        ]),
      ).toEqual([
        ["small", Option.some("0.016"), 0.5],
        ["large", Option.some("0.016"), 1],
      ]);
    }),
  );

  it("leaves an unpriced variant out of the scatter and shows n/a in the table", () => {
    const chart = Charts.costVsAccuracy(runOf("run-a", [scoredAt("good", 1, true)], 1));

    const spec = Charts.toVegaLite(chart, Theme.computis);

    expect(spec["data"]).toEqual({ values: [] });
    expect(View.chartTable(chart).rows.map((row) => row[1]?.text)).toEqual(["n/a"]);
  });
});

describe("Chart.delta", () => {
  it.effect("has a row per ratio that both runs measure", () =>
    Effect.gen(function* () {
      const { base, head } = yield* sampleRuns;

      const chart = Charts.delta(Run.compare(head, base), "small");
      const rows = Charts.$is("Delta")(chart) ? chart.rows : [];

      expect(rows.find((row) => row.metric === "accuracy")?.value).toBeCloseTo(-0.25);
    }),
  );

  it("carries the paired interval of each delta and draws it as a whisker", () => {
    const ids = Array.from({ length: 20 }, (_, index) => `case-${String(index)}`);
    const chart = Charts.delta(
      Run.compare(
        runOf(
          "head",
          ids.map((id, index) => scoredAs({ case: id, right: index < 16 })),
        ),
        runOf(
          "base",
          ids.map((id, index) => scoredAs({ case: id, right: index < 10 })),
        ),
      ),
      "default",
    );
    const accuracy = (Charts.$is("Delta")(chart) ? chart.rows : []).find(
      (row) => row.metric === "accuracy",
    );
    const spec = JSON.stringify(Charts.toVegaLite(chart, Theme.computis));

    expect([
      Option.isSome(accuracy?.low ?? Option.none()),
      Option.isSome(accuracy?.high ?? Option.none()),
    ]).toEqual([true, true]);
    expect(spec).toContain('"x2":{"field":"high"}');
    expect(View.chartTable(chart).columns).toEqual(["metric", "delta", "low", "high"]);
  });
});

describe("Chart.toVegaLite", () => {
  it.effect("gives every chart kind a Vega-Lite spec with its data, title and theme", () =>
    Effect.gen(function* () {
      const charts = yield* everyChart;

      const specs = charts.map((chart) => Charts.toVegaLite(chart, Theme.computis));

      expect(specs.map((spec) => spec["title"])).toEqual(charts.map((chart) => chart.title));
      expect(specs.map((spec) => spec["$schema"])).toEqual(
        charts.map(() => "https://vega.github.io/schema/vega-lite/v6.json"),
      );
      expect(
        specs.map((spec) => {
          const { config } = spec;
          return Json.isRecord(config) ? config["background"] : undefined;
        }),
      ).toEqual(charts.map(() => Theme.computis.surface));
      expect(
        (["CaseMap", "CostVsAccuracy", "Delta", "Transitions", "Trend", "Variants"] as const).map(
          (kind) => charts.filter(Charts.$is(kind)).length,
        ),
      ).toEqual([1, 1, 1, 1, 1, 1]);
    }),
  );

  it("writes a missing interval bound as null", () => {
    const spec = Charts.toVegaLite(
      Charts.Variants({
        bars: [{ high: Option.none(), low: Option.none(), value: 0.5, variant: "small" }],
        metric: "accuracy",
        title: "accuracy by variant",
      }),
      Theme.computis,
    );

    expect(spec["data"]).toEqual({
      values: [{ high: null, low: null, value: 0.5, variant: "small" }],
    });
  });
});

describe("Chart.hconcat", () => {
  it("puts the specs side by side under one schema and config", () => {
    const left = Charts.toVegaLite(Charts.Delta({ rows: [], title: "left" }), Theme.computis);
    const right = Charts.toVegaLite(Charts.Delta({ rows: [], title: "right" }), Theme.computis);

    const spec = Charts.hconcat([left, right], Theme.computis);

    expect(spec["hconcat"]).toMatchObject([{ title: "left" }, { title: "right" }]);
    expect(JSON.stringify(spec["hconcat"])).not.toContain("$schema");
  });
});
