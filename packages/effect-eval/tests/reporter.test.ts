import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { DateTime, Effect, Exit, FileSystem, Layer, Option, Path, PubSub, Stream } from "effect";
import * as Dataset from "../src/dataset.ts";
import * as Eval from "../src/eval.ts";
import type { EvalEvent } from "../src/events.ts";
import * as Events from "../src/events.ts";
import * as History from "../src/history.ts";
import * as Reporter from "../src/reporter.ts";
import * as Reporters from "../src/reporters.ts";
import type { Run } from "../src/run.ts";
import * as Runner from "../src/runner.ts";
import * as Scorer from "../src/scorer.ts";

const categorizer = (size: number) =>
  Eval.make({
    dataset: Dataset.fromIterable(
      Array.from({ length: size }, (_, index) => `m${String(index)}`),
      { id: (id: string) => id },
    ),
    name: "categorizer",
    score: Scorer.label<string, string>({ actual: Option.some, expected: Scorer.present }),
    task: (input) => Effect.succeed(input.input),
  });

describe("Reporter.make", () => {
  it.effect("calls each hook with its event and onRunFinished with the folded run", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const finished: Run[] = [];

      const hooks = Reporter.make({
        name: "hooks",
        onCaseFinished: (event) => Effect.sync(() => calls.push(`case ${event.case}`)),
        onRunFinished: (run) => Effect.sync(() => finished.push(run)),
        onRunStarted: (event) => Effect.sync(() => calls.push(`start ${event.eval}`)),
        onVariantFinished: (event) => Effect.sync(() => calls.push(`variant ${event.variant}`)),
      });

      const run = yield* Runner.run(categorizer(2)).pipe(Effect.provide(Reporter.layer([hooks])));

      expect(calls).toEqual(["start categorizer", "case m0", "case m1", "variant default"]);
      expect(finished.map((folded) => [folded.id, folded.variants[0]?.summary])).toEqual([
        [run.id, run.variants[0]?.summary],
      ]);
    }),
  );
});

describe("Reporter.layer", () => {
  it.effect("keeps a run going when an optional reporter fails and names it in the run", () =>
    Effect.gen(function* () {
      const run = yield* Runner.run(categorizer(1)).pipe(
        Effect.provide(
          Reporter.layer([Reporter.fromStream("broken", () => Effect.fail("disk full"))]),
        ),
      );

      expect(run.failedReporters).toEqual(["broken"]);
    }),
  );

  it.effect("fails the run when a required reporter fails", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        Runner.run(categorizer(1)).pipe(
          Effect.provide(
            Reporter.layer([
              Reporter.required(Reporter.fromStream("broken", () => Effect.fail("disk full"))),
            ]),
          ),
        ),
      );

      expect(failure).toMatchObject({ reporter: "broken" });
    }),
  );

  it.effect("needs the services of every reporter of a mixed list, with no type argument", () =>
    Effect.gen(function* () {
      const written: string[] = [];

      const mixed = Reporter.layer([
        Reporters.history,
        Reporters.markdown({
          write: (text) =>
            Effect.sync(() => {
              written.push(text);
            }),
        }),
      ]);

      expectTypeOf(mixed).toEqualTypeOf<
        Layer.Layer<never, never, History.History | FileSystem.FileSystem | Path.Path>
      >();

      const { run, stored } = yield* Effect.gen(function* () {
        const finished = yield* Runner.run(categorizer(1)).pipe(Effect.provide(mixed));

        return { run: finished, stored: yield* History.list("categorizer") };
      }).pipe(
        Effect.provide(Layer.mergeAll(History.layerMemory, FileSystem.layerNoop({}), Path.layer)),
      );

      expect([run.failedReporters, written.length, stored.length]).toEqual([[], 1, 1]);
    }),
  );

  it("also accepts the existing explicit service parameter", () => {
    expectTypeOf(Reporter.layer<History.History>([Reporters.history])).toEqualTypeOf<
      Layer.Layer<never, never, History.History>
    >();
  });

  it("needs no service for an empty list", () => {
    expectTypeOf(Reporter.layer([])).toEqualTypeOf<Layer.Layer<never>>();
  });
});

const envelope = (sequence: number) =>
  ({
    at: DateTime.makeUnsafe(0),
    runId: "run",
    sequence,
    version: 1,
  }) as const;

const throwing = Reporter.fromStream<never, never>("throwing", () => {
  throw new Error("reporter initialization failed");
});

describe("Reporter lifetime", () => {
  it.effect("releases the resources of a reporter before each run returns", () =>
    Effect.gen(function* () {
      const counts = { acquired: 0, released: 0 };

      const counted = Reporter.fromStream("resource", (events) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            counts.acquired += 1;
          }),
          () =>
            Effect.sync(() => {
              counts.released += 1;
            }),
        ).pipe(Effect.andThen(Stream.runDrain(events))),
      );

      const afterEach = yield* Effect.gen(function* () {
        yield* Runner.run(categorizer(1));
        const first = { ...counts };
        yield* Runner.run(categorizer(1));

        return [first, { ...counts }];
      }).pipe(Effect.provide(Reporter.layer([counted])));

      expect(afterEach).toEqual([
        { acquired: 1, released: 1 },
        { acquired: 2, released: 2 },
      ]);
    }),
  );

  it.effect("fails the run when the release of a required reporter fails", () =>
    Effect.gen(function* () {
      const breaking = Reporter.required(
        Reporter.fromStream("breaking", (events) =>
          Effect.acquireRelease(Effect.void, () => Effect.die("release failed")).pipe(
            Effect.andThen(Stream.runDrain(events)),
          ),
        ),
      );

      const failure = yield* Effect.flip(
        Runner.run(categorizer(1)).pipe(Effect.provide(Reporter.layer([breaking]))),
      );

      expect(failure).toMatchObject({ reporter: "breaking" });
    }),
  );

  it.effect("isolates an optional reporter that throws, and fails on a required one", () =>
    Effect.gen(function* () {
      const run = yield* Runner.run(categorizer(1)).pipe(
        Effect.provide(Reporter.layer([throwing])),
      );

      const failure = yield* Effect.flip(
        Runner.run(categorizer(1)).pipe(
          Effect.provide(Reporter.layer([Reporter.required(throwing)])),
        ),
      );

      expect([run.failedReporters, run.variants[0]?.summary.counts["right"]]).toEqual([
        ["throwing"],
        1,
      ]);
      expect(failure).toMatchObject({ reporter: "throwing" });
    }),
  );

  it.effect("isolates an optional comparison that throws", () =>
    Effect.gen(function* () {
      const run = yield* Runner.run(categorizer(1));

      const comparing = Reporter.make({
        name: "comparing",
        onComparison: () => {
          throw new Error("comparison failed");
        },
      });

      const exit = yield* Reporter.compare(run, run).pipe(
        Effect.provide(Reporter.layer([comparing])),
        Effect.exit,
      );

      expect(exit).toEqual(Exit.void);
    }),
  );
});

describe("Reporter.subscribe", () => {
  const started = (sequence: number): EvalEvent => ({
    ...envelope(sequence),
    _tag: "CaseStarted",
    case: `m${String(sequence)}`,
    tags: [],
    trial: 1,
    variant: "default",
  });

  const skipped = (sequence: number): EvalEvent => ({
    ...envelope(sequence),
    _tag: "CaseSkipped",
    id: `s${String(sequence)}`,
    reason: "no truth",
  });

  const finished = (sequence: number): EvalEvent => ({
    ...envelope(sequence),
    _tag: "RunFinished",
    durationMs: 0,
    failedReporters: [],
    interrupted: false,
    passed: true,
  });

  it.effect("delivers every event up to RunFinished with the all delivery", () =>
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<EvalEvent>();
      const stream = yield* Reporter.subscribe(pubsub, Reporter.deliveries.all);

      yield* PubSub.publishAll(pubsub, [skipped(0), started(1), finished(2), skipped(3)]);
      const events = yield* Stream.runCollect(stream);

      expect(events.map((event) => event.sequence)).toEqual([0, 1, 2]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps every lifecycle event in order with the sliding delivery", () =>
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<EvalEvent>();
      const stream = yield* Reporter.subscribe(pubsub, Reporter.deliveries.sliding);
      const progress = Array.from({ length: 400 }, (_, index) => started(index + 1));

      yield* PubSub.publishAll(pubsub, [skipped(0), ...progress, skipped(401), finished(402)]);
      const events = yield* Stream.runCollect(stream);

      expect(
        events.filter((event) => !Events.isCaseStarted(event)).map((event) => event.sequence),
      ).toEqual([0, 401, 402]);
    }).pipe(Effect.scoped),
  );

  it.effect("delivers the sliding events in sequence order, RunStarted first", () =>
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<EvalEvent>();
      const stream = yield* Reporter.subscribe(pubsub, Reporter.deliveries.sliding);
      const progress = Array.from({ length: 10 }, (_, index) => started(index + 1));

      yield* PubSub.publishAll(pubsub, [skipped(0), ...progress, finished(11)]);
      const events = yield* Stream.runCollect(stream);

      expect(events.map((event) => event.sequence)).toEqual(
        Array.from({ length: 12 }, (_, index) => index),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("runs onRunStarted of a sliding reporter before any case reaches it", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const ready = { started: false };

      const initialized = Reporter.required(
        Reporter.sliding(
          Reporter.make({
            name: "initialized",
            onCaseFinished: () =>
              Effect.sync(() => {
                calls.push(ready.started ? "case" : "case-before-start");
              }),
            onRunStarted: () =>
              Effect.sync(() => {
                ready.started = true;
              }),
          }),
        ),
      );

      const run = yield* Runner.run(categorizer(10)).pipe(
        Effect.provide(Reporter.layer([initialized])),
      );

      expect(run.failedReporters).toEqual([]);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.filter((call) => call !== "case")).toEqual([]);
    }),
  );

  it.effect("delivers strictly increasing sequence numbers while cases run concurrently", () =>
    Effect.gen(function* () {
      const seen: number[] = [];

      const uneven = Eval.make({
        dataset: Dataset.fromIterable(
          Array.from({ length: 1000 }, (_, index) => index),
          { id: String },
        ),
        name: "uneven",
        score: Scorer.label<number, string>({
          actual: Option.some,
          expected: (index) => Scorer.present(String(index)),
        }),
        task: (input) =>
          Effect.gen(function* () {
            for (let step = 0; step < (input.input * 37) % 2048; step += 1) {
              yield* Effect.sync(() => step);
            }

            return String(input.input);
          }),
      });

      yield* Runner.run(uneven, { concurrency: 20 }).pipe(
        Effect.provide(
          Reporter.layer([
            Reporter.fromStream("record", (events) =>
              Stream.runForEach(events, (event) =>
                Effect.sync(() => {
                  seen.push(event.sequence);
                }),
              ),
            ),
          ]),
        ),
      );

      expect(
        seen.filter((sequence, index) => index > 0 && sequence <= (seen[index - 1] ?? -1)),
      ).toEqual([]);
      expect(seen.length).toBeGreaterThan(2000);
    }),
  );

  it.effect("keeps the lifecycle events of a real run when the reporter falls behind", () =>
    Effect.gen(function* () {
      const seen: EvalEvent[] = [];

      const slow = Reporter.sliding(
        Reporter.fromStream(
          "slow",
          Stream.runForEach((event) =>
            Effect.sync(() => seen.push(event)).pipe(Effect.andThen(Effect.yieldNow)),
          ),
        ),
      );

      const run = yield* Runner.run(categorizer(600)).pipe(Effect.provide(Reporter.layer([slow])));

      expect(run.failedReporters).toEqual([]);
      expect(
        seen.filter((event) => !Events.isCaseStarted(event) && !Events.isCaseFinished(event)),
      ).toMatchObject([
        { _tag: "RunStarted" },
        { _tag: "VariantFinished" },
        { _tag: "RunFinished" },
      ]);
    }),
  );
});
