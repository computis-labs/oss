import { Clock, Effect, Predicate } from "effect";
import { TestClock } from "effect/testing";

export const withLive = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.withFiber((fiber) =>
    Predicate.hasProperty(fiber.getRef(Clock.Clock), "withLive")
      ? TestClock.withLive(effect)
      : effect,
  );
