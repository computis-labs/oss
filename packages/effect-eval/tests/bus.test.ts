import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Stream } from "effect";
import * as Agreement from "../src/agreement.ts";
import * as Bus from "../src/bus.ts";
import type { EvalEvent } from "../src/events.ts";
import * as Events from "../src/events.ts";
import * as Observation from "../src/observation.ts";
import * as Reporter from "../src/reporter.ts";
import * as Usage from "../src/usage.ts";

const caseFinished = {
  _tag: "CaseFinished",
  case: "p1",
  durationMs: 12,
  inputHash: "abc",
  judgements: [{ hash: "h", key: "judge:faithful", result: { reason: "RSSMRA80A01H501U" } }],
  observations: [
    Observation.compared({
      agreement: Agreement.exact,
      detail: { actual: "RSSMRA80A01H501U", expected: "RSSMRA80A01H501U" },
      key: "codiceFiscale",
    }),
  ],
  output: Option.some({ codiceFiscale: "RSSMRA80A01H501U" }),
  outputError: Option.some("unencodable: RSSMRA80A01H501U is too long"),
  trial: 1,
  usage: Usage.empty,
  variant: "default",
} as const;

const runFinished = {
  _tag: "RunFinished",
  durationMs: 20,
  failedReporters: [],
  interrupted: false,
  passed: true,
} as const;

const recording = (sink: EvalEvent[], options: Reporter.Options = {}) =>
  Reporter.fromStream(
    "recording",
    Stream.runForEach((event) => Effect.sync(() => sink.push(event))),
    options,
  );

const failing = (options: Reporter.Options = {}) =>
  Reporter.fromStream("broken", () => Effect.fail("disk full"), options);

describe("Bus.open", () => {
  it.effect("stamps every event with the run id and a growing sequence", () =>
    Effect.gen(function* () {
      const seen: EvalEvent[] = [];
      const bus = yield* Bus.open("run-1", [recording(seen)], false);

      yield* bus.emit({ _tag: "CaseSkipped", id: "p9", reason: "no golden XML" });
      yield* bus.emit(runFinished);
      yield* bus.close;

      expect(seen.map((event) => [event.runId, event.sequence])).toEqual([
        ["run-1", 0],
        ["run-1", 1],
      ]);
      expect(bus.events).toEqual(seen);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "redacts the details and the output of a sensitive run for a reporter that does not accept them",
    () =>
      Effect.gen(function* () {
        const redacted: EvalEvent[] = [];
        const trusted: EvalEvent[] = [];
        const bus = yield* Bus.open(
          "run-2",
          [recording(redacted), Reporter.acceptingSensitive(recording(trusted))],
          true,
        );

        yield* bus.emit(caseFinished);
        yield* bus.emit(runFinished);
        yield* bus.close;

        expect(redacted.filter(Events.isCaseFinished)).toMatchObject([
          {
            judgements: [],
            observations: [{ detail: { actual: "[redacted]", expected: "[redacted]" } }],
            output: Option.none(),
            outputError: Option.some("[redacted]"),
          },
        ]);
        expect(trusted.filter(Events.isCaseFinished)).toMatchObject([
          {
            observations: [{ detail: { actual: "RSSMRA80A01H501U" } }],
            output: Option.some({ codiceFiscale: "RSSMRA80A01H501U" }),
          },
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect("redacts the failure of an errored case and of its observations", () =>
    Effect.gen(function* () {
      const redacted: EvalEvent[] = [];
      const trusted: EvalEvent[] = [];
      const bus = yield* Bus.open(
        "run-2b",
        [recording(redacted), Reporter.acceptingSensitive(recording(trusted))],
        true,
      );
      const failure = "Invalid response for RSSMRA80A01H501U";

      yield* bus.emit({
        ...caseFinished,
        _tag: "CaseErrored",
        failure,
        observations: [Observation.errored("codiceFiscale", failure, { expected: "present" })],
      });
      yield* bus.emit(runFinished);
      yield* bus.close;

      expect(redacted.filter(Events.isCaseErrored)).toMatchObject([
        {
          failure: "[redacted]",
          observations: [{ failure: Option.some("[redacted]") }],
        },
      ]);
      expect(trusted.filter(Events.isCaseErrored)).toMatchObject([
        { failure, observations: [{ failure: Option.some(failure) }] },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the details for every reporter when the run is not sensitive", () =>
    Effect.gen(function* () {
      const seen: EvalEvent[] = [];
      const bus = yield* Bus.open("run-3", [recording(seen)], false);

      yield* bus.emit(caseFinished);
      yield* bus.emit(runFinished);
      yield* bus.close;

      expect(seen.find(Events.isCaseFinished)?.observations[0]?.detail.actual).toBe(
        "RSSMRA80A01H501U",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("returns the names of the optional reporters that failed", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.open("run-4", [failing(), recording([])], false);

      yield* bus.emit(runFinished);

      expect(yield* bus.close).toEqual(["broken"]);
    }).pipe(Effect.scoped),
  );

  it.effect("fails the close when a required reporter failed", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.open("run-5", [Reporter.required(failing())], false);

      yield* bus.emit(runFinished);
      const failure = yield* Effect.flip(bus.close);

      expect(failure.reporter).toBe("broken");
    }).pipe(Effect.scoped),
  );
});
