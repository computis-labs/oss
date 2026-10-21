import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import * as Statistics from "../src/statistics.ts";

const bounds = (interval: Option.Option<readonly [number, number]>) =>
  Option.getOrElse(interval, () => [Number.NaN, Number.NaN] as const);

describe("Statistics.wilson", () => {
  it("matches the reference 95% interval for 8 successes out of 10", () => {
    const [low, high] = bounds(Statistics.wilson(8, 10));

    expect(low).toBeCloseTo(0.4902, 4);
    expect(high).toBeCloseTo(0.9433, 4);
  });

  it("stays inside zero and one when every trial succeeds", () => {
    const [low, high] = bounds(Statistics.wilson(5, 5));

    expect(low).toBeCloseTo(0.5655, 4);
    expect(high).toBeCloseTo(1, 10);
  });

  it("has no interval without trials", () => {
    expect(Statistics.wilson(0, 0)).toEqual(Option.none());
  });

  it("takes the confidence it receives", () => {
    const [low, high] = bounds(Statistics.wilson(5, 10, { confidence: 0.99 }));
    const [lowest, highest] = bounds(Statistics.wilson(5, 10, { confidence: 0.8 }));

    expect(low).toBeCloseTo(0.1842255182, 8);
    expect(high).toBeCloseTo(0.8157744818, 8);
    expect(lowest).toBeCloseTo(0.3122044449, 8);
    expect(highest).toBeCloseTo(0.6877955551, 8);
  });
});

describe("Statistics.bootstrap", () => {
  const credits = [1, 0.5, 0.25, 0, 1, 1, 0.5, 0];

  it("gives the same interval for the same seed", () => {
    expect(Statistics.bootstrap(credits, { seed: "golden-set" })).toEqual(
      Statistics.bootstrap(credits, { seed: "golden-set" }),
    );
  });

  it("gives another interval for another seed", () => {
    expect(Statistics.bootstrap(credits, { resamples: 200, seed: "a" })).not.toEqual(
      Statistics.bootstrap(credits, { resamples: 200, seed: "b" }),
    );
  });

  it("brackets the mean of the values", () => {
    const [low, high] = bounds(Statistics.bootstrap(credits, { seed: "golden-set" }));

    expect(low).toBeLessThan(0.53125);
    expect(high).toBeGreaterThan(0.53125);
  });

  it("has no interval without values", () => {
    expect(Statistics.bootstrap([], { seed: "golden-set" })).toEqual(Option.none());
  });
});

describe("Statistics.mcnemar", () => {
  it("gives the exact two sided p-value of the discordant pairs", () => {
    expect(Statistics.mcnemar(0, 6).pValue).toBeCloseTo(0.03125);
    expect(Statistics.mcnemar(1, 5).pValue).toBeCloseTo(0.21875);
  });

  it("gives one when the two sides never disagree", () => {
    expect(Statistics.mcnemar(0, 0).pValue).toBe(1);
  });

  it("caps the p-value at one for balanced disagreements", () => {
    expect(Statistics.mcnemar(3, 3).pValue).toBe(1);
  });
});

describe("Statistics.passAtK and passHatK", () => {
  it("estimates pass@k as one minus C(n-c, k) / C(n, k)", () => {
    expect(Statistics.passAtK(5, 2, 2)).toBeCloseTo(0.7);
  });

  it("estimates pass^k as C(c, k) / C(n, k)", () => {
    expect(Statistics.passHatK(5, 2, 2)).toBeCloseTo(0.1);
  });

  it("is sure of pass@k when fewer than k trials failed", () => {
    expect(Statistics.passAtK(3, 2, 2)).toBe(1);
  });

  it("rules out pass^k when fewer than k trials passed", () => {
    expect(Statistics.passHatK(3, 1, 2)).toBe(0);
  });
});

describe("Statistics.mean and standardDeviation", () => {
  it("computes the sample standard deviation", () => {
    expect(Statistics.mean([2, 4, 4, 4, 5, 5, 7, 9])).toBe(5);
    expect(Statistics.standardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
  });

  it("gives zero for fewer than two values", () => {
    expect([Statistics.mean([]), Statistics.standardDeviation([0.7])]).toEqual([0, 0]);
  });
});

describe("Statistics.seededRandom", () => {
  it("draws the same numbers in [0, 1) for the same seed", () => {
    const first = Statistics.seededRandom("seed");
    const second = Statistics.seededRandom("seed");
    const draws = [first(), first(), first()];

    expect([second(), second(), second()]).toEqual(draws);
    expect(draws.every((draw) => draw >= 0 && draw < 1)).toBe(true);
  });
});
