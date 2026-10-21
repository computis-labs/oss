import {
  DateTime,
  Effect,
  Exit,
  Fiber,
  MutableRef,
  Option,
  PubSub,
  Ref,
  Semaphore,
  Stream,
  identity,
  pipe,
} from "effect";
import { withLive } from "./clock.ts";
import { EvalReporterFailed } from "./errors/eval-reporter-failed.ts";
import { EVENTS_VERSION } from "./events.ts";
import type { EvalEvent, EventBody } from "./events.ts";
import { RedactsSensitive, SensitiveExposure, UNLOGGED, redactEvent } from "./redact.ts";
import { RunEvents, subscribe } from "./reporter.ts";
import type { Installed } from "./reporter.ts";

export interface Bus {
  readonly emit: (body: EventBody) => Effect.Effect<void>;
  readonly failed: Effect.Effect<readonly string[]>;
  readonly close: Effect.Effect<readonly string[], EvalReporterFailed>;
  readonly events: readonly EvalEvent[];
}

export const open = Effect.fn("Bus.open")(function* openBus(
  runId: string,
  reporters: readonly Installed[],
  sensitive: boolean,
) {
  const pubsub = yield* PubSub.unbounded<EvalEvent>();
  const events: EvalEvent[] = [];
  const sequence = yield* Ref.make(0);
  const ordering = yield* Semaphore.make(1);
  const fibers = yield* pipe(
    reporters,
    Effect.forEach((reporter) => {
      const shown = sensitive && !reporter.acceptsSensitive ? redactEvent : identity<EvalEvent>;
      const exposed = MutableRef.make(false);
      return subscribe(pubsub, reporter.delivery).pipe(
        Effect.flatMap((stream) =>
          Effect.scoped(
            Effect.suspend(() => reporter.consume(stream.pipe(Stream.map(shown)))).pipe(
              Effect.provideService(RunEvents, Option.some(Effect.sync(() => events.map(shown)))),
              Effect.provideService(RedactsSensitive, !reporter.acceptsSensitive),
              Effect.provideService(SensitiveExposure, Option.some(exposed)),
            ),
          ).pipe(Effect.exit, Effect.forkScoped),
        ),
        Effect.map((fiber) => ({ exposed, fiber, reporter })),
      );
    }),
  );
  const emit = (body: EventBody) =>
    Effect.gen(function* emitEvent() {
      const index = yield* Ref.getAndUpdate(sequence, (value) => value + 1);
      const at = yield* withLive(DateTime.now);
      const event: EvalEvent = { ...body, at, runId, sequence: index, version: EVENTS_VERSION };
      events.push(event);
      yield* PubSub.publish(pubsub, event);
    }).pipe(Semaphore.withPermits(ordering, 1));
  const failed = Effect.yieldNow.pipe(
    Effect.andThen(
      pipe(
        fibers,
        Effect.forEach(({ fiber, reporter }) =>
          Effect.sync(() => fiber.pollUnsafe()).pipe(
            Effect.map((polled) =>
              Option.exists(
                Option.fromNullishOr(polled),
                (exit) => Exit.isFailure(exit) || Exit.isFailure(exit.value),
              )
                ? [reporter.name]
                : [],
            ),
          ),
        ),
      ),
    ),
    Effect.map((names) => names.flat()),
  );
  const close = Effect.gen(function* closeBus() {
    const exits = yield* pipe(
      fibers,
      Effect.forEach(({ exposed, fiber, reporter }) =>
        Fiber.join(fiber).pipe(
          Effect.map((exit) => ({
            exit,
            quiet: sensitive || MutableRef.get(exposed),
            reporter,
          })),
        ),
      ),
    );
    const broken = exits.filter(({ exit }) => Exit.isFailure(exit));
    yield* Effect.forEach(
      broken,
      ({ exit, quiet, reporter }) =>
        quiet
          ? Effect.logWarning(`The reporter ${reporter.name} failed. ${UNLOGGED}`)
          : Effect.logWarning(`The reporter ${reporter.name} failed.`, exit),
      { discard: true },
    );
    const requiredFailure = broken.find(({ reporter }) => reporter.required);
    if (requiredFailure !== undefined) {
      return yield* new EvalReporterFailed({
        cause: requiredFailure.quiet ? UNLOGGED : requiredFailure.exit,
        reporter: requiredFailure.reporter.name,
      });
    }
    return broken.map(({ reporter }) => reporter.name);
  });
  const bus: Bus = { close, emit, events, failed };
  return bus;
});
