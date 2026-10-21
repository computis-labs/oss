import { describe, expect, it } from "@effect/vitest";
import { Clock, Effect } from "effect";
import { withLive } from "../src/clock.ts";

const REAL_TIME_AFTER = 1_704_067_200_000;

describe("withLive", () => {
  it.effect("reads the real time while the test clock is still at zero", () =>
    Effect.gen(function* () {
      const testTime = yield* Clock.currentTimeMillis;
      const realTime = yield* withLive(Clock.currentTimeMillis);

      expect(testTime).toBe(0);
      expect(realTime).toBeGreaterThan(REAL_TIME_AFTER);
    }),
  );

  it.live("runs the effect on the live clock outside the test clock", () =>
    Effect.gen(function* () {
      expect(yield* withLive(Clock.currentTimeMillis)).toBeGreaterThan(REAL_TIME_AFTER);
    }),
  );
});
