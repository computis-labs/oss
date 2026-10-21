import { describe, expect, it } from "@effect/vitest";
import * as Agreement from "../src/agreement.ts";

describe("Agreement.partial", () => {
  it("keeps a score strictly between zero and one as a partial agreement", () => {
    expect(Agreement.partial(0.4)).toEqual({ _tag: "Partial", score: 0.4 });
  });

  it("turns a full score into an exact agreement", () => {
    expect(Agreement.partial(1)).toEqual(Agreement.exact);
  });

  it("turns a zero score into a different agreement", () => {
    expect(Agreement.partial(0)).toEqual(Agreement.different);
  });
});

describe("Agreement.credit", () => {
  it("gives one to an exact agreement, the score to a partial one and zero to a different one", () => {
    expect([
      Agreement.credit(Agreement.exact),
      Agreement.credit(Agreement.partial(0.25)),
      Agreement.credit(Agreement.different),
    ]).toEqual([1, 0.25, 0]);
  });
});
