import { describe, expect, it } from "@effect/vitest";
import * as Execution from "../src/execution.ts";

const cases = ["p1", "p2", "p3", "p4", "p5"];

describe("Execution.batchesOf", () => {
  it("gives every case its own batch per case", () => {
    expect(Execution.batchesOf(Execution.perCase(), cases)).toEqual([
      ["p1"],
      ["p2"],
      ["p3"],
      ["p4"],
      ["p5"],
    ]);
  });

  it("cuts the cases into batches of the size in order", () => {
    expect(Execution.batchesOf(Execution.batched(2), cases)).toEqual([
      ["p1", "p2"],
      ["p3", "p4"],
      ["p5"],
    ]);
  });

  it("puts every case in one batch for the whole dataset", () => {
    expect(Execution.batchesOf(Execution.whole, cases)).toEqual([cases]);
  });

  it("has no batch for an empty dataset run whole", () => {
    expect(Execution.batchesOf(Execution.whole, [])).toEqual([]);
  });
});

describe("Execution.concurrencyOf", () => {
  it("runs one batch at a time unless told otherwise", () => {
    expect([
      Execution.concurrencyOf(Execution.perCase()),
      Execution.concurrencyOf(Execution.batched(20)),
      Execution.concurrencyOf(Execution.whole),
    ]).toEqual([1, 1, 1]);
  });

  it("uses the concurrency of a per case or batched execution", () => {
    expect([
      Execution.concurrencyOf(Execution.perCase({ concurrency: 8 })),
      Execution.concurrencyOf(Execution.batched(20, { concurrency: 2 })),
    ]).toEqual([8, 2]);
  });
});
