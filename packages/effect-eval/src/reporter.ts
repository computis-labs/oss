import {
  Context,
  Effect,
  Exit,
  Layer,
  Match,
  MutableRef,
  Option,
  PubSub,
  Queue,
  Ref,
  Scope,
  Stream,
  pipe,
} from "effect";
import type { PlatformError } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { EvalReporterError } from "./errors/eval-reporter-error.ts";
import { EvalReporterFailed } from "./errors/eval-reporter-failed.ts";
import * as Events from "./events.ts";
import type {
  CaseErrored,
  CaseFinished,
  EvalEvent,
  GateEvaluated,
  RunStarted,
  VariantFinished,
} from "./events.ts";
import { fold } from "./run.ts";
import type { Run } from "./run.ts";
import { whenDefined } from "./object.ts";
import { RedactsSensitive, SensitiveExposure, UNLOGGED, redactRun } from "./redact.ts";

export const deliveries = {
  all: "all",
  sliding: "sliding",
} as const;

export type Delivery = (typeof deliveries)[keyof typeof deliveries];

const SLIDING_CAPACITY = 256;

const isProgress = (event: EvalEvent) =>
  Events.isCaseStarted(event) || Events.isCaseFinished(event) || Events.isCaseErrored(event);

export const destinations = {
  file: "file",
  stdout: "stdout",
} as const;

export type Destination = (typeof destinations)[keyof typeof destinations];

export interface Reporter<E = never, R = never> {
  readonly name: string;
  readonly delivery: Delivery;
  readonly required: boolean;
  readonly acceptsSensitive: boolean;
  readonly destination?: Destination;
  readonly consume: (events: Stream.Stream<EvalEvent>) => Effect.Effect<void, E, R | Scope.Scope>;
  readonly compare?: (base: Run, head: Run) => Effect.Effect<void, E, R>;
}

export interface Options {
  readonly delivery?: Delivery;
  readonly required?: boolean;
  readonly acceptsSensitive?: boolean;
  readonly destination?: Destination;
}

export const fromStream = <E, R>(
  name: string,
  consume: (events: Stream.Stream<EvalEvent>) => Effect.Effect<void, E, R | Scope.Scope>,
  options: Options & {
    readonly compare?: (base: Run, head: Run) => Effect.Effect<void, E, R>;
  } = {},
): Reporter<E, R> => ({
  acceptsSensitive: options.acceptsSensitive ?? false,
  consume,
  delivery: options.delivery ?? deliveries.all,
  name,
  required: options.required ?? false,
  ...whenDefined(options.compare, (compare) => ({ compare })),
  ...whenDefined(options.destination, (destination) => ({ destination })),
});

type Hook<Event, E, R> = (event: Event) => Effect.Effect<void, E, R>;

export interface Hooks<E, R> extends Options {
  readonly name: string;
  readonly onRunStarted?: Hook<typeof RunStarted.Type, E, R>;
  readonly onCaseFinished?: Hook<typeof CaseFinished.Type, E, R>;
  readonly onCaseErrored?: Hook<typeof CaseErrored.Type, E, R>;
  readonly onVariantFinished?: Hook<typeof VariantFinished.Type, E, R>;
  readonly onGateEvaluated?: Hook<typeof GateEvaluated.Type, E, R>;
  readonly onRunFinished?: (run: Run) => Effect.Effect<void, E, R>;
  readonly onComparison?: (base: Run, head: Run) => Effect.Effect<void, E, R>;
}

const ignore = () => Effect.void;

export const RunEvents = Context.Reference<Option.Option<Effect.Effect<readonly EvalEvent[]>>>(
  "effect-eval/RunEvents",
  { defaultValue: () => Option.none() },
);

export const make = <E = never, R = never>(hooks: Hooks<E, R>): Reporter<E, R> =>
  fromStream(
    hooks.name,
    (events) => {
      const seen: EvalEvent[] = [];

      return pipe(
        events,
        Stream.runForEach((event) => {
          seen.push(event);

          return Match.valueTags(event, {
            CaseErrored: hooks.onCaseErrored ?? ignore,
            CaseFinished: hooks.onCaseFinished ?? ignore,
            CaseSkipped: ignore,
            CaseStarted: ignore,
            GateEvaluated: hooks.onGateEvaluated ?? ignore,
            RunFinished: () => {
              const { onRunFinished } = hooks;

              if (onRunFinished === undefined) {
                return Effect.void;
              }

              return Effect.service(RunEvents).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.succeed<readonly EvalEvent[]>(seen),
                    onSome: (all) => all,
                  }),
                ),
                Effect.flatMap(fold),
                Effect.orDie,
                Effect.flatMap(onRunFinished),
              );
            },
            RunStarted: hooks.onRunStarted ?? ignore,
            VariantFinished: hooks.onVariantFinished ?? ignore,
          });
        }),
      );
    },
    {
      ...hooks,
      ...whenDefined(hooks.onComparison, (compare) => ({ compare })),
    },
  );

export const silent: Reporter = fromStream("silent", Stream.runDrain);

export const process = (
  name: string,
  command: string,
  args: readonly string[] = [],
  options: Options = {},
): Reporter<
  EvalReporterError | PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  fromStream(
    name,
    (events) =>
      Effect.gen(function* runProcess() {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

        const handle = yield* spawner.spawn(
          ChildProcess.make(command, args, {
            stderr: "inherit",
            stdin: events.pipe(
              Stream.mapEffect((event) => Effect.orDie(Events.encodeLine(event))),
              Stream.map((line) => `${line}\n`),
              Stream.encodeText,
            ),
            stdout: "inherit",
          }),
        );

        yield* handle.exitCode.pipe(
          Effect.filterOrFail(
            (code) => code === 0,
            (code) =>
              new EvalReporterError({
                message: `${command} exited with code ${String(code)}.`,
                reporter: name,
              }),
          ),
        );
      }),
    options,
  );

export const required = <E, R>(self: Reporter<E, R>): Reporter<E, R> => ({
  ...self,
  required: true,
});

export const sliding = <E, R>(self: Reporter<E, R>): Reporter<E, R> => ({
  ...self,
  delivery: deliveries.sliding,
});

export const acceptingSensitive = <E, R>(self: Reporter<E, R>): Reporter<E, R> => ({
  ...self,
  acceptsSensitive: true,
});

export type Installed = Reporter<unknown>;

export const Reporters = Context.Reference<readonly Installed[]>("effect-eval/Reporters", {
  defaultValue: () => [],
});

export type Services<T> = T extends Reporter<unknown, infer R> ? R : never;

export function layer<T extends Reporter<unknown, unknown> = never>(
  reporters: readonly T[],
): Layer.Layer<never, never, Services<T>>;
export function layer<R>(reporters: readonly Reporter<unknown, R>[]): Layer.Layer<never, never, R>;
export function layer<R>(reporters: readonly Reporter<unknown, R>[]): Layer.Layer<never, never, R> {
  return Layer.effect(
    Reporters,
    Effect.context<R>().pipe(
      Effect.map((context) =>
        reporters.map(({ compare: draw, consume, ...rest }): Installed => ({
          ...rest,
          consume: (events) =>
            Effect.scope.pipe(
              Effect.flatMap((scope) =>
                Effect.suspend(() => consume(events)).pipe(
                  Effect.provideContext(Context.add(context, Scope.Scope, scope)),
                ),
              ),
            ),
          ...whenDefined(draw, (given) => ({
            compare: (base: Run, head: Run) =>
              Effect.scoped(
                Effect.scope.pipe(
                  Effect.flatMap((scope) =>
                    Effect.suspend(() => given(base, head)).pipe(
                      Effect.provideContext(Context.add(context, Scope.Scope, scope)),
                    ),
                  ),
                ),
              ),
          })),
        })),
      ),
    ),
  );
}

export const compare = Effect.fn("Reporter.compare")(function* compareRuns(base: Run, head: Run) {
  const reporters = yield* Reporters;
  const sensitive = base.sensitive || head.sensitive;

  const exits = yield* pipe(
    reporters,
    Effect.forEach((reporter) => {
      const exposed = MutableRef.make(false);

      return Option.match(Option.fromNullishOr(reporter.compare), {
        onNone: () => Effect.succeed(Option.none<Exit.Exit<void, unknown>>()),
        onSome: (draw) =>
          Effect.suspend(() =>
            sensitive && !reporter.acceptsSensitive
              ? draw(redactRun(base), redactRun(head))
              : draw(base, head),
          ).pipe(
            Effect.provideService(RedactsSensitive, !reporter.acceptsSensitive),
            Effect.provideService(SensitiveExposure, Option.some(exposed)),
            Effect.exit,
            Effect.map((exit) => Option.some(exit)),
          ),
      }).pipe(
        Effect.map((exit) => ({
          exit,
          quiet: sensitive || MutableRef.get(exposed),
          reporter,
        })),
      );
    }),
  );

  const broken = exits.flatMap(({ exit, quiet, reporter }) =>
    Option.toArray(exit).flatMap((found) =>
      Exit.isFailure(found) ? [{ exit: found, quiet, reporter }] : [],
    ),
  );

  yield* Effect.forEach(
    broken,
    ({ exit, quiet, reporter }) =>
      quiet
        ? Effect.logWarning(`The reporter ${reporter.name} failed to compare. ${UNLOGGED}`)
        : Effect.logWarning(`The reporter ${reporter.name} failed to compare.`, exit),
    { discard: true },
  );
  const requiredFailure = broken.find(({ reporter }) => reporter.required);

  return yield* requiredFailure === undefined
    ? Effect.void
    : Effect.fail(
        new EvalReporterFailed({
          cause: requiredFailure.quiet ? UNLOGGED : requiredFailure.exit,
          reporter: requiredFailure.reporter.name,
        }),
      );
});

export const subscribe = Effect.fn("Reporter.subscribe")(function* subscribeReporter(
  pubsub: PubSub.PubSub<EvalEvent>,
  delivery: Delivery,
) {
  const subscription = yield* PubSub.subscribe(pubsub);
  const events = Stream.fromSubscription(subscription).pipe(Stream.takeUntil(Events.isRunFinished));

  if (delivery === deliveries.all) {
    return events;
  }

  const buffer = yield* Ref.make<{
    readonly events: readonly EvalEvent[];
    readonly ended: boolean;
  }>({
    ended: false,
    events: [],
  });

  const doorbell = yield* Queue.sliding<boolean>(1);
  yield* pipe(
    events,
    Stream.runForEach((event) =>
      Ref.update(buffer, (current) => {
        const appended = [...current.events, event];
        const oldest = appended.findIndex(isProgress);

        return {
          ...current,
          events:
            appended.filter(isProgress).length > SLIDING_CAPACITY
              ? [...appended.slice(0, oldest), ...appended.slice(oldest + 1)]
              : appended,
        };
      }).pipe(Effect.andThen(Queue.offer(doorbell, true))),
    ),
    Effect.ensuring(
      Ref.update(buffer, (current) => ({ ...current, ended: true })).pipe(
        Effect.andThen(Queue.offer(doorbell, true)),
      ),
    ),
    Effect.forkScoped,
  );

  const drain = (): Effect.Effect<readonly [readonly EvalEvent[], Option.Option<boolean>]> =>
    Ref.modify(buffer, (current) => [current, { ...current, events: [] }]).pipe(
      Effect.flatMap((taken) => {
        if (taken.events.length > 0) {
          return Effect.succeed([taken.events, Option.some(true)] as const);
        }

        return taken.ended
          ? Effect.succeed([[], Option.none<boolean>()] as const)
          : Queue.take(doorbell).pipe(Effect.andThen(drain));
      }),
    );

  return Stream.paginate(true, drain);
});
