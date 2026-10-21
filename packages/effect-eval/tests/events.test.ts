import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema, Stream, pipe } from "effect";
import * as Dataset from "../src/dataset.ts";
import * as Eval from "../src/eval.ts";
import * as Events from "../src/events.ts";
import type { EvalEvent } from "../src/events.ts";
import * as Gate from "../src/gate.ts";
import * as Metric from "../src/metric.ts";
import * as Reporter from "../src/reporter.ts";
import * as Runner from "../src/runner.ts";
import * as Scorer from "../src/scorer.ts";

const recordRun = Effect.gen(function* () {
  const events: EvalEvent[] = [];
  const categorize = Eval.make({
    dataset: Dataset.fromIterable(["rent", "fuel", "fail", Dataset.skip("gone", "no truth")], {
      id: (id: string) => id,
      tags: () => ["group:bank"],
    }),
    gates: [Gate.min(Metric.accuracy, 0.5)],
    name: "categorizer",
    output: Schema.String,
    score: Scorer.label<string, string>({ actual: Option.some, expected: Scorer.present }),
    task: (input) => (input.id === "fail" ? Effect.fail("timeout") : Effect.succeed(input.input)),
    trials: 2,
  });
  yield* Runner.run(categorize).pipe(
    Effect.provide(
      Reporter.layer([
        Reporter.fromStream(
          "recording",
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        ),
      ]),
    ),
  );
  return events;
});

describe("Events.encodeLine and decodeLine", () => {
  it.effect("round trip every kind of event a run emits", () =>
    Effect.gen(function* () {
      const events = yield* recordRun;

      const decoded = yield* pipe(
        events,
        Effect.forEach((event) => Events.encodeLine(event).pipe(Effect.flatMap(Events.decodeLine))),
      );

      expect(decoded).toEqual(events);
      expect([
        events.some(Events.isRunStarted),
        events.some(Events.isCaseSkipped),
        events.some(Events.isCaseStarted),
        events.some(Events.isCaseFinished),
        events.some(Events.isCaseErrored),
        events.some(Events.isVariantFinished),
        events.some(Events.isGateEvaluated),
        events.some(Events.isRunFinished),
      ]).toEqual([true, true, true, true, true, true, true, true]);
    }),
  );

  it.effect("writes one JSON object per line with the events version", () =>
    Effect.gen(function* () {
      const [first] = yield* recordRun;
      const line = first === undefined ? "" : yield* Events.encodeLine(first);

      expect(line).not.toContain("\n");
      expect(JSON.parse(line)).toMatchObject({ eval: "categorizer", sequence: 0, version: 1 });
    }),
  );

  it.effect("refuses a line of another events version", () =>
    Effect.gen(function* () {
      const [first] = yield* recordRun;
      const line = first === undefined ? "" : yield* Events.encodeLine(first);

      const failure = yield* Effect.flip(
        Events.decodeLine(line.replace('"version":1', '"version":2')),
      );

      expect(Schema.isSchemaError(failure)).toBe(true);
    }),
  );
});
