import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import * as Agreement from "../src/agreement.ts";
import * as Observation from "../src/observation.ts";
import { actualStates, expectedStates } from "../src/observation.ts";
import * as Verdict from "../src/verdict.ts";
import { verdicts } from "../src/verdict.ts";

const detail = { actual: "", expected: "" };

const compared = (agreement: Agreement.Agreement) =>
  Observation.compared({ agreement, detail, key: "natura" });

const missing = Observation.make({
  actual: actualStates.absent,
  detail,
  expected: expectedStates.present,
  key: "natura",
});

describe("Verdict.of", () => {
  it("calls an exact agreement right", () => {
    expect(Verdict.of(compared(Agreement.exact))).toBe(verdicts.right);
  });

  it("calls a partial agreement partial", () => {
    expect(Verdict.of(compared(Agreement.partial(0.6)))).toBe(verdicts.partial);
  });

  it("calls a different agreement wrong", () => {
    expect(Verdict.of(compared(Agreement.different))).toBe(verdicts.wrong);
  });

  it("calls an expected value that did not come missed", () => {
    expect(Verdict.of(missing)).toBe(verdicts.missed);
  });

  it("calls a missing value with a known gap a gap", () => {
    expect(Verdict.of(Observation.knownGap("the bank sends no reference")(missing))).toBe(
      verdicts.gap,
    );
  });

  it("calls a correct abstention right", () => {
    expect(
      Verdict.of(
        Observation.make({
          actual: actualStates.absent,
          detail,
          expected: expectedStates.absent,
          key: "natura",
        }),
      ),
    ).toBe(verdicts.right);
  });

  it("calls an answer where none was expected wrong", () => {
    expect(
      Verdict.of(
        Observation.make({
          actual: actualStates.present,
          detail,
          expected: expectedStates.absent,
          key: "natura",
        }),
      ),
    ).toBe(verdicts.wrong);
  });

  it("calls an observation with an unknown expectation unscored", () => {
    expect(
      Verdict.of(
        Observation.make({
          actual: actualStates.present,
          detail,
          expected: expectedStates.unknown,
          key: "natura",
        }),
      ),
    ).toBe(verdicts.unscored);
  });

  it("calls a failed task errored", () => {
    expect(
      Verdict.of(Observation.errored("natura", "timeout", { expected: expectedStates.present })),
    ).toBe(verdicts.errored);
  });

  it("lets an exclusion win over an error", () => {
    const observation = Observation.exclude("convention")(
      Observation.errored("natura", "timeout", { expected: expectedStates.present }),
    );

    expect(Verdict.of(observation)).toBe(verdicts.excluded);
  });

  it("lets an error win over an unknown expectation", () => {
    expect(
      Verdict.of(Observation.errored("natura", "timeout", { expected: expectedStates.unknown })),
    ).toBe(verdicts.errored);
  });

  it("lets an exclusion win over an exact agreement", () => {
    expect(Verdict.of(Observation.exclude("pending")(compared(Agreement.exact)))).toBe(
      verdicts.excluded,
    );
  });

  it("calls a present pair without an agreement wrong", () => {
    expect(Verdict.of({ ...compared(Agreement.exact), agreement: Option.none() })).toBe(
      verdicts.wrong,
    );
  });
});
