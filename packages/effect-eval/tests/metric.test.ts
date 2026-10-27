import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import * as Agreement from "../src/agreement.ts";
import * as Metric from "../src/metric.ts";
import * as Observation from "../src/observation.ts";
import { actualStates, expectedStates } from "../src/observation.ts";

const detail = { actual: "", expected: "" };

const right = (key: string) => Observation.compared({ agreement: Agreement.exact, detail, key });

const wrong = (key: string) =>
  Observation.compared({ agreement: Agreement.different, detail, key });

const partial = (key: string, score: number) =>
  Observation.compared({ agreement: Agreement.partial(score), detail, key });

const missed = (key: string) =>
  Observation.make({ actual: actualStates.absent, detail, expected: expectedStates.present, key });

const abstained = (key: string) =>
  Observation.make({ actual: actualStates.absent, detail, expected: expectedStates.absent, key });

const falsePositive = (key: string) =>
  Observation.make({ actual: actualStates.present, detail, expected: expectedStates.absent, key });

const unscored = (key: string) =>
  Observation.make({ actual: actualStates.present, detail, expected: expectedStates.unknown, key });

const errored = (key: string) =>
  Observation.errored(key, "timeout", { expected: expectedStates.present });

const ratio = (metric: Metric.RatioMetric, observations: readonly Observation.Observation[]) =>
  Metric.estimate(metric, Metric.judge(observations));

const valueOf = (metric: Metric.RatioMetric, observations: readonly Observation.Observation[]) =>
  Option.getOrElse(ratio(metric, observations).value, () => Number.NaN);

describe("the reconciliation example of the spec", () => {
  const movements = [
    right("m1"),
    right("m2"),
    wrong("m3"),
    unscored("m4"),
    abstained("m5"),
    abstained("m6"),
  ];

  it("answers four movements out of six", () => {
    expect(ratio(Metric.answered, movements)).toMatchObject({ n: 6 });
    expect(valueOf(Metric.answered, movements)).toBeCloseTo(4 / 6);
  });

  it("has a precision of two out of three", () => {
    expect(ratio(Metric.precision, movements)).toMatchObject({ n: 3 });
    expect(valueOf(Metric.precision, movements)).toBeCloseTo(2 / 3);
  });

  it("has a recall of two out of three", () => {
    expect(ratio(Metric.recall, movements)).toMatchObject({ n: 3 });
    expect(valueOf(Metric.recall, movements)).toBeCloseTo(2 / 3);
  });
});

describe("Metric.summary", () => {
  it("counts the observations of each verdict", () => {
    const summary = Metric.summary([
      right("a"),
      right("b"),
      partial("c", 0.5),
      wrong("d"),
      missed("e"),
      Observation.knownGap("the bank sends no reference")(missed("f")),
      unscored("g"),
      errored("h"),
      Observation.exclude("convention")(wrong("i")),
      falsePositive("j"),
    ]);

    expect(summary.counts).toEqual({
      errored: 1,
      excluded: 1,
      "excluded(convention)": 1,
      falsePositives: 1,
      gap: 1,
      missed: 1,
      partial: 1,
      right: 2,
      unscored: 1,
      wrong: 2,
    });
    expect(summary.observations).toBe(10);
  });

  it("estimates every ratio", () => {
    const summary = Metric.summary([right("a"), wrong("b")]);

    expect(Object.keys(summary.ratios).toSorted()).toEqual([
      "accuracy",
      "answered",
      "meanAgreement",
      "precision",
      "recall",
    ]);
  });
});

describe("Metric.read", () => {
  const summary = Metric.summary([
    right("m1"),
    right("m2"),
    wrong("m3"),
    unscored("m4"),
    abstained("m5"),
    abstained("m6"),
  ]);

  it("reads a ratio with the hits behind its value", () => {
    expect(Metric.read(summary, Metric.precision)).toMatchObject({
      hits: 2,
      n: 3,
      value: Option.some(2 / 3),
    });
    expect(Metric.read(summary, Metric.answered)).toMatchObject({ hits: 4, n: 6 });
  });

  it("reads a count as a number", () => {
    expect([
      Metric.read(summary, Metric.right),
      Metric.read(summary, Metric.wrong),
      Metric.read(summary, Metric.unscored),
    ]).toEqual([4, 1, 1]);
  });

  it("reads the observations excluded for a reason, and none for a reason no observation has", () => {
    const excludedSummary = Metric.summary([
      Observation.exclude("pending")(right("a")),
      Observation.exclude("pending")(missed("b")),
      Observation.exclude("convention")(wrong("c")),
    ]);

    expect([
      Metric.read(excludedSummary, Metric.excluded()),
      Metric.read(excludedSummary, Metric.excluded("pending")),
      Metric.read(excludedSummary, Metric.excluded("convention")),
      Metric.read(excludedSummary, Metric.excluded("extra")),
    ]).toEqual([3, 2, 1, 0]);
  });

  it("reads the credit of partial answers as hits", () => {
    expect(
      Metric.read(Metric.summary([right("a"), partial("b", 0.5), wrong("c")]), Metric.accuracy),
    ).toMatchObject({ hits: 1.5, n: 3 });
  });

  it("reads a ratio that has nothing to measure as zero hits out of zero", () => {
    expect(Metric.read(Metric.summary([]), Metric.recall)).toMatchObject({
      hits: 0,
      n: 0,
      value: Option.none(),
    });
  });
});

describe("Metric.excluded", () => {
  it("counts every exclusion, or only the ones with the reason", () => {
    const judged = Metric.judge([
      Observation.exclude("convention")(right("a")),
      Observation.exclude("unclassified")(right("b")),
      Observation.exclude("unclassified")(wrong("c")),
    ]);

    expect([
      Metric.count(Metric.excluded(), judged),
      Metric.count(Metric.excluded("unclassified"), judged),
    ]).toEqual([3, 2]);
  });
});

describe("Metric.answered", () => {
  it("does not count an errored observation as an answer", () => {
    expect(valueOf(Metric.answered, [right("a"), errored("b")])).toBeCloseTo(1 / 2);
  });

  it("leaves the excluded observations out of the denominator", () => {
    expect(
      ratio(Metric.answered, [right("a"), Observation.exclude("pending")(missed("b"))]),
    ).toMatchObject({ n: 1 });
  });
});

describe("Metric.accuracy", () => {
  it("credits a partial agreement with its score", () => {
    expect(
      valueOf(Metric.accuracy, [right("a"), partial("b", 0.5), wrong("c"), missed("d")]),
    ).toBeCloseTo(1.5 / 4);
  });

  it("counts an errored observation as wrong and leaves an unscored one out", () => {
    const estimate = ratio(Metric.accuracy, [right("a"), errored("b"), unscored("c")]);

    expect(estimate.n).toBe(2);
    expect(Option.getOrElse(estimate.value, () => Number.NaN)).toBeCloseTo(1 / 2);
  });

  it("leaves out a case with an unknown expected value whether its task answered or failed", () => {
    const failed = Observation.errored("c", "timeout", { expected: expectedStates.unknown });

    expect(ratio(Metric.accuracy, [right("a"), wrong("b"), failed])).toEqual(
      ratio(Metric.accuracy, [right("a"), wrong("b"), unscored("c")]),
    );
  });

  it("uses a Wilson interval without partial credit", () => {
    const estimate = ratio(Metric.accuracy, [right("a"), right("b"), right("c"), wrong("d")]);
    const [low, high] = Option.getOrElse(estimate.interval, () => [Number.NaN, Number.NaN]);

    expect(low).toBeCloseTo(0.3006, 3);
    expect(high).toBeCloseTo(0.9544, 3);
  });

  it("bootstraps the interval with partial credit and keeps it around the value", () => {
    const estimate = ratio(Metric.accuracy, [
      right("a"),
      partial("b", 0.5),
      partial("c", 0.25),
      wrong("d"),
    ]);

    const [low, high] = Option.getOrElse(estimate.interval, () => [Number.NaN, Number.NaN]);

    expect(low).toBeLessThanOrEqual(0.4375);
    expect(high).toBeGreaterThanOrEqual(0.4375);
    expect(
      ratio(Metric.accuracy, [right("a"), partial("b", 0.5), partial("c", 0.25), wrong("d")])
        .interval,
    ).toEqual(estimate.interval);
  });

  it("is not measurable without evaluated observations", () => {
    expect(
      ratio(Metric.accuracy, [unscored("a"), Observation.exclude("pending")(right("b"))]),
    ).toEqual({
      hits: 0,
      interval: Option.none(),
      n: 0,
      value: Option.none(),
    });
  });
});

describe("Metric.meanAgreement", () => {
  it("averages the credit where both sides are present", () => {
    expect(
      valueOf(Metric.meanAgreement, [right("a"), partial("b", 0.5), wrong("c"), missed("d")]),
    ).toBeCloseTo(1.5 / 3);
  });

  it("takes a bootstrap interval, also when every agreement is exact", () => {
    expect(ratio(Metric.meanAgreement, [right("a"), right("b")]).interval).toEqual(
      Option.some([1, 1]),
    );
    expect(ratio(Metric.accuracy, [right("a"), right("b")]).interval).not.toEqual(
      Option.some([1, 1]),
    );
  });
});

describe("Metric.falsePositives", () => {
  it("counts the answers given where none was expected", () => {
    expect(
      Metric.count(
        Metric.falsePositives,
        Metric.judge([falsePositive("a"), wrong("b"), abstained("c")]),
      ),
    ).toBe(1);
  });
});

describe("Metric.by", () => {
  it("summarizes the observations of each group tag", () => {
    const groups = Metric.by("group")([
      Observation.tagged("group:fiscal")(right("tipoDocumento")),
      Observation.tagged("group:fiscal")(wrong("natura")),
      Observation.tagged("group:supplier")(right("denominazione")),
      right("untagged"),
    ]);

    expect(Object.keys(groups).toSorted()).toEqual(["fiscal", "supplier"]);
    expect(groups["fiscal"]?.counts).toMatchObject({ right: 1, wrong: 1 });
    expect(groups["supplier"]?.counts).toMatchObject({ right: 1, wrong: 0 });
  });

  it("counts an observation once in a group, however often it carries the tag", () => {
    const groups = Metric.by("group")([
      Observation.tagged("group:fiscal", "group:fiscal")(right("natura")),
      Observation.tagged("group:fiscal")(wrong("aliquota")),
    ]);

    expect(groups["fiscal"]?.ratios["accuracy"]).toMatchObject({
      n: 2,
      value: Option.some(0.5),
    });
  });
});

describe("Metric.formatEstimate", () => {
  it("shows the value, the interval and n", () => {
    expect(
      Metric.formatEstimate({
        hits: 4,
        interval: Option.some([0.25, 0.75]),
        n: 8,
        value: Option.some(0.5),
      }),
    ).toBe("0.500 [0.250, 0.750] (n=8)");
  });

  it("says a ratio without a denominator is not measurable", () => {
    expect(
      Metric.formatEstimate({ hits: 0, interval: Option.none(), n: 0, value: Option.none() }),
    ).toBe("not measurable");
  });
});

describe("Metric.value", () => {
  it("measures a count and a ratio alike", () => {
    const judged = Metric.judge([right("a"), wrong("b")]);

    expect([Metric.value(Metric.wrong, judged), Metric.value(Metric.accuracy, judged)]).toEqual([
      Option.some(1),
      Option.some(0.5),
    ]);
  });
});
