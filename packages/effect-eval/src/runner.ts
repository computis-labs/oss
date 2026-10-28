import {
  Array,
  Cause,
  Clock,
  Effect,
  Equal,
  Exit,
  Layer,
  Option,
  Random,
  Ref,
  Result,
  Schema,
  pipe,
} from "effect";
import type { Scope } from "effect";
import { withLive } from "./clock.ts";
import * as Bus from "./bus.ts";
import * as Dataset from "./dataset.ts";
import type { Case, FilterOptions, Loaded, SampleOptions } from "./dataset.ts";
import { EvalBudgetExceeded } from "./errors/eval-budget-exceeded.ts";
import { EvalConfigError } from "./errors/eval-config-error.ts";
import type { EvalDatasetError } from "./errors/eval-dataset-error.ts";
import type { EvalReporterFailed } from "./errors/eval-reporter-failed.ts";
import type { Eval } from "./eval.ts";
import type { EventBody, Judgement, Scored } from "./events.ts";
import { batchesOf, concurrencyOf } from "./execution.ts";
import * as Gate from "./gate.ts";
import { Git } from "./git.ts";
import * as History from "./history.ts";
import { canonical, sha256 } from "./json.ts";
import { Judgements, memory } from "./judgements.ts";
import { Reporters } from "./reporter.ts";
import { fold, variantRun } from "./run.ts";
import type { Run, StoredOutput } from "./run.ts";
import type { Outcome } from "./scorer.ts";
import * as Usages from "./usage.ts";
import { Meter } from "./usage.ts";
import type { Usage } from "./usage.ts";
import * as Variants from "./variant.ts";
import type { Variant } from "./variant.ts";

export interface Selection {
  readonly filter?: FilterOptions;
  readonly sample?: SampleOptions;
}

export type ResolvedBaseline = History.ResolvedBaseline;

export interface Options<ROut = never, VE = never, RIn = never> extends Selection {
  readonly variants?: readonly Variant<ROut, VE, RIn>[];
  readonly trials?: number;
  readonly concurrency?: number;
  readonly confirmed?: boolean;
  readonly baselines?: readonly ResolvedBaseline[];
  readonly reportBaseline?: History.Selector;
}

export interface PlanResult {
  readonly cases: number;
  readonly skipped: number;
  readonly batches: number;
  readonly variants: number;
  readonly trials: number;
  readonly invocations: number;
}

const RUN_ID_RANDOM = 36 ** 6;
const RUN_ID_TIME_WIDTH = 9;
const RUN_ID_RANDOM_WIDTH = 6;
const UNHASHED = "unhashed";
const BUDGET = "budget: the run reached its maxCalls";
const NOT_STORED = "missing: the stored run has no output for this case";
const STALE = "stale: the input changed since the stored run";
const UNDECODABLE = "undecodable: the stored output does not match the output schema";
const UNENCODABLE = "unencodable";
const exhausted = { reason: BUDGET } as const;

export const validVariants = (names: readonly string[]) => {
  const repeated = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];

  if (names.length === 0) {
    return Effect.fail(
      new EvalConfigError({ message: "Choose at least one variant.", path: "variants" }),
    );
  }

  return repeated.length === 0
    ? Effect.void
    : Effect.fail(
        new EvalConfigError({
          message: `Every variant needs its own name, but ${repeated.join(", ")} appears more than once.`,
          path: "variants",
        }),
      );
};

const NO_CODEC = "missing: the eval declares no output schema, so no output was stored";
const LINE_BREAK = "\n";

const liveMillis = withLive(Clock.currentTimeMillis);

const failureMessage = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }));

const failureOf = (cause: Cause.Cause<unknown>) =>
  Option.getOrElse(
    Option.map(failureMessage(Cause.squash(cause)), (failure) => failure.message),
    () => {
      const pretty = Cause.pretty(cause).split(LINE_BREAK)[0] ?? "";

      return pretty.startsWith("Error: ") ? pretty.slice("Error: ".length) : pretty;
    },
  );

const isJson = Schema.is(Schema.Json);

const outputKey = (variant: string, trial: number, id: string) =>
  JSON.stringify([variant, trial, id]);

const taskUnit = (variant: string, trial: number, id: string) =>
  JSON.stringify(["task", variant, trial, id]);

const scoreUnit = (variant: string, trial: number, id: string) =>
  JSON.stringify(["score", variant, trial, id]);

export const validTrials = (trials: number) =>
  Number.isInteger(trials) && trials > 0
    ? Effect.succeed(trials)
    : Effect.fail(
        new EvalConfigError({
          message: `The trials must be a positive integer, got ${String(trials)}.`,
          path: "trials",
        }),
      );

const trialsOf = <A, O, E, DE, R, DR, SR>(
  self: Eval<A, O, E, DE, R, DR, SR>,
  trials: number | undefined,
) => validTrials(self.trials).pipe(Effect.andThen(validTrials(trials ?? self.trials)));

const select = <A, O, E, DE, R, DR, SR>(self: Eval<A, O, E, DE, R, DR, SR>, selection: Selection) =>
  Dataset.load(
    pipe(
      self.dataset,
      (dataset) =>
        selection.filter === undefined ? dataset : Dataset.filter(selection.filter)(dataset),
      (dataset) =>
        selection.sample === undefined ? dataset : Dataset.sample(selection.sample)(dataset),
    ),
  );

const hashCases = <A, O, E, DE, R, DR, SR>(self: Eval<A, O, E, DE, R, DR, SR>, loaded: Loaded<A>) =>
  pipe(
    loaded.cases,
    Effect.forEach((input) =>
      Option.match(self.hash, {
        onNone: () =>
          pipe(
            Option.liftPredicate(input.input, isJson),
            Option.match({
              onNone: () => Effect.succeed(UNHASHED),
              onSome: (json) => sha256(canonical(json)),
            }),
          ),
        onSome: (hash) => sha256(hash(input.input)),
      }).pipe(Effect.map((hash) => [input.id, hash] as const)),
    ),
    Effect.map((entries) => new Map(entries)),
  );

export const plan = Effect.fn("Eval.plan")(function* planRun<A, O, E, DE, R, DR, SR>(
  self: Eval<A, O, E, DE, R, DR, SR>,
  options: Selection & {
    readonly variants?: number;
    readonly trials?: number;
  } = {},
) {
  const trials = yield* trialsOf(self, options.trials);
  const loaded = yield* select(self, options);
  const batches = batchesOf(self.execution, loaded.cases).length;
  const variants = options.variants ?? 1;

  const result: PlanResult = {
    batches,
    cases: loaded.cases.length,
    invocations: batches * variants * trials,
    skipped: loaded.skipped.length,
    trials,
    variants,
  };

  return result;
});

interface BatchResult<O> {
  readonly outcomes: readonly Outcome<O>[];
  readonly usage: Usage;
  readonly durationMs: number;
}

type Obtain<A, O, R> = (
  batch: Array.NonEmptyReadonlyArray<Case<A>>,
  record: (usage: Usage) => Effect.Effect<void>,
) => Effect.Effect<BatchResult<O>, never, R>;

interface Source<A, O, R> {
  readonly rescoreOf: Option.Option<string>;
  readonly judgements: (variant: string, trial: number, id: string) => readonly Judgement[];
  readonly open: (
    variant: string,
    trial: number,
  ) => Effect.Effect<Obtain<A, O, R>, never, R | Scope.Scope>;
}

const execute = Effect.fn("Eval.execute")(function* executeRun<
  A,
  O,
  E,
  DE,
  R,
  DR,
  SR,
  ROut,
  VE,
  RIn,
>(
  self: Eval<A, O, E, DE, R, DR, SR>,
  loaded: Loaded<A>,
  settings: {
    readonly variants: readonly Variant<ROut, VE, RIn>[];
    readonly trials: number;
    readonly concurrency: number;
    readonly source: Source<A, O, R>;
    readonly baselines: readonly ResolvedBaseline[];
    readonly reportBaseline: Option.Option<History.Selector>;
  },
) {
  const batches = batchesOf(self.execution, loaded.cases);
  const reporters = yield* Reporters;
  const git = yield* (yield* Git).current;
  const millis = yield* liveMillis;
  const random = yield* Random.nextIntBetween(0, RUN_ID_RANDOM);

  const runId = `${millis.toString(36).padStart(RUN_ID_TIME_WIDTH, "0")}${random
    .toString(36)
    .padStart(RUN_ID_RANDOM_WIDTH, "0")}`;

  const hashes = yield* hashCases(self, loaded);

  const datasetHash = yield* sha256(
    [...hashes].map(([id, hash]) => `${id}:${hash}`).join(LINE_BREAK),
  );

  const history = yield* Effect.serviceOption(History.History);
  const variantNames = settings.variants.map((variant) => variant.name);

  const resolved = yield* pipe(
    Array.dedupeWith(
      [
        ...Gate.baselinesOf(self.gates),
        Option.getOrElse(settings.reportBaseline, () => History.baseline()),
      ],
      Equal.equals,
    ),
    Effect.forEach((selector) =>
      Option.match(
        Option.fromNullishOr(
          settings.baselines.find(([candidate]) => Equal.equals(candidate, selector)),
        ),
        {
          onNone: () =>
            Option.match(history, {
              onNone: () => Effect.succeed(Option.none<Run>()),
              onSome: (service) =>
                History.resolve(self.name, selector, variantNames).pipe(
                  Effect.provideService(History.History, service),
                  Effect.option,
                ),
            }),
          onSome: ([, found]) => Effect.succeed(found),
        },
      ).pipe(Effect.map((found): ResolvedBaseline => [selector, found])),
    ),
  );

  const baselines: Gate.Baselines = (selector) =>
    Option.flatMap(
      Option.fromNullishOr(resolved.find(([candidate]) => Equal.equals(candidate, selector))),
      ([, found]) => found,
    );

  return yield* Effect.scoped(
    Effect.gen(function* runScoped() {
      const bus = yield* Bus.open(runId, reporters, self.sensitive);
      const start = yield* liveMillis;
      const ended = yield* Ref.make(false);

      const unreported = yield* Ref.make<
        ReadonlyMap<string, { readonly variant: string; readonly usage: Usage }>
      >(new Map());

      const pend = (unit: string, variant: string) => (usage: Usage) =>
        Ref.update(unreported, (current) => {
          const next = new Map(current);
          next.set(unit, {
            usage: Usages.add(current.get(unit)?.usage ?? Usages.empty, usage),
            variant,
          });

          return next;
        });

      const settle = (units: readonly string[]) =>
        Ref.update(unreported, (current) => {
          const next = new Map(current);

          for (const unit of units) {
            next.delete(unit);
          }

          return next;
        });

      const finish = (passed: boolean, interrupted: boolean) =>
        Ref.getAndSet(ended, true).pipe(
          Effect.flatMap((already) =>
            already
              ? Effect.void
              : Effect.gen(function* emitFinished() {
                  const now = yield* liveMillis;
                  const failedReporters = yield* bus.failed;
                  const pending = [...(yield* Ref.get(unreported)).values()];
                  yield* bus.emit({
                    _tag: "RunFinished",
                    durationMs: now - start,
                    failedReporters,
                    interrupted,
                    passed,
                    unreportedUsage: [...new Set(pending.map((entry) => entry.variant))].map(
                      (variant) => ({
                        usage: Usages.total(
                          pending.flatMap((entry) =>
                            entry.variant === variant ? [entry.usage] : [],
                          ),
                        ),
                        variant,
                      }),
                    ),
                  });
                }),
          ),
          Effect.uninterruptible,
        );

      const scoreCase = (variant: string, trial: number, input: Case<A>, outcome: Outcome<O>) =>
        Effect.gen(function* scoreMetered() {
          const spent = yield* Ref.make(Usages.empty);
          const made = yield* Ref.make<readonly Judgement[]>([]);
          const recordUnreported = pend(scoreUnit(variant, trial, input.id), variant);

          const observations = yield* self.score(input, outcome).pipe(
            Effect.provideService(Meter, {
              record: (usage) =>
                Effect.uninterruptible(
                  Ref.update(spent, (current) => Usages.add(current, usage)).pipe(
                    Effect.andThen(recordUnreported(usage)),
                  ),
                ),
            }),
            Effect.provideService(
              Judgements,
              memory(settings.source.judgements(variant, trial, input.id), (judgement) =>
                Ref.update(made, (current) => [...current, judgement]),
              ),
            ),
          );

          const keys = observations.map((observation) => observation.key);
          const repeated = [...new Set(keys.filter((key, index) => keys.indexOf(key) !== index))];

          if (repeated.length > 0) {
            return yield* new EvalConfigError({
              message: `The scorer gave case ${input.id} more than one observation with the key ${repeated
                .map((key) => JSON.stringify(key))
                .join(
                  ", ",
                )}. Give each label or set of Scorer.all its own key, each judge its own name and each field its own key.`,
              path: "score",
            });
          }

          return {
            judgements: yield* Ref.get(made),
            observations,
            usage: yield* Ref.get(spent),
          };
        });

      const scoreBatch = (
        variant: string,
        trial: number,
        obtain: Obtain<A, O, R>,
        batch: Array.NonEmptyReadonlyArray<Case<A>>,
      ) =>
        Effect.gen(function* scoreBatchRun() {
          yield* Effect.forEach(
            batch,
            (input) =>
              bus.emit({ _tag: "CaseStarted", case: input.id, tags: input.tags, trial, variant }),
            { discard: true },
          );

          const obtained = yield* obtain(
            batch,
            pend(taskUnit(variant, trial, batch[0].id), variant),
          );

          return yield* Effect.forEach(
            batch,
            (input, index) =>
              Effect.gen(function* scoreOne() {
                const outcome: Outcome<O> = Option.getOrElse(
                  Array.get(obtained.outcomes, index),
                  () =>
                    Result.fail(
                      `The task returned ${String(obtained.outcomes.length)} outputs for ${String(batch.length)} cases.`,
                    ),
                );

                const scored = yield* scoreCase(variant, trial, input, outcome);
                const usage = Usages.add(index === 0 ? obtained.usage : Usages.empty, scored.usage);

                const common = {
                  case: input.id,
                  durationMs: obtained.durationMs,
                  inputHash: hashes.get(input.id) ?? UNHASHED,
                  judgements: scored.judgements,
                  observations: scored.observations,
                  trial,
                  usage,
                  variant,
                };

                const event = yield* Result.match(outcome, {
                  onFailure: (failure) =>
                    Effect.succeed<EventBody>({ ...common, _tag: "CaseErrored", failure }),
                  onSuccess: (output) =>
                    Option.match(self.output, {
                      onNone: () =>
                        Effect.succeed({
                          output: Option.none<Schema.Json>(),
                          outputError: Option.none<string>(),
                        }),
                      onSome: (codec) =>
                        Schema.encodeEffect(codec)(output).pipe(
                          Effect.match({
                            onFailure: (error) => ({
                              output: Option.none<Schema.Json>(),
                              outputError: Option.some(
                                `${UNENCODABLE}: ${error.message.split(LINE_BREAK)[0] ?? ""}`,
                              ),
                            }),
                            onSuccess: (encoded) => ({
                              output: Option.some(encoded),
                              outputError: Option.none<string>(),
                            }),
                          }),
                        ),
                    }).pipe(
                      Effect.tap(({ outputError }) =>
                        Option.match(outputError, {
                          onNone: () => Effect.void,
                          onSome: (reason) =>
                            Effect.logWarning(
                              self.sensitive
                                ? `The output of ${input.id} was not stored: ${UNENCODABLE}; the eval is sensitive, so the reason stays in the run`
                                : `The output of ${input.id} was not stored: ${reason}`,
                            ),
                        }),
                      ),
                      Effect.map((stored): EventBody => ({
                        ...common,
                        ...stored,
                        _tag: "CaseFinished",
                      })),
                    ),
                });

                yield* Effect.uninterruptible(
                  bus
                    .emit(event)
                    .pipe(
                      Effect.andThen(
                        settle([
                          scoreUnit(variant, trial, input.id),
                          ...(index === 0 ? [taskUnit(variant, trial, input.id)] : []),
                        ]),
                      ),
                    ),
                );

                return {
                  scored: scored.observations.map((observation): Scored => ({
                    case: input.id,
                    observation,
                    trial,
                    variant,
                  })),
                  usage,
                };
              }),
            { discard: false },
          );
        });

      const body = Effect.gen(function* runBody() {
        yield* Effect.forEach(
          loaded.skipped,
          (skipped) => bus.emit({ _tag: "CaseSkipped", id: skipped.id, reason: skipped.reason }),
          { discard: true },
        );

        const variantRuns = yield* Effect.forEach(
          settings.variants,
          (variant) =>
            Effect.gen(function* runVariant() {
              const variantStart = yield* liveMillis;

              const results = yield* Effect.forEach(
                Array.range(1, settings.trials),
                (trial) =>
                  Effect.scoped(
                    settings.source.open(variant.name, trial).pipe(
                      Effect.flatMap((obtain) =>
                        Effect.forEach(
                          batches,
                          (batch) =>
                            scoreBatch(variant.name, trial, obtain, batch).pipe(
                              Effect.withSpan("Eval.batch", {
                                attributes: {
                                  cases: batch.map((input) => input.id),
                                  eval: self.name,
                                  trial,
                                  variant: variant.name,
                                },
                              }),
                            ),
                          { concurrency: settings.concurrency },
                        ),
                      ),
                    ),
                  ).pipe(
                    Effect.withSpan("Eval.trial", {
                      attributes: { eval: self.name, trial, variant: variant.name },
                    }),
                  ),
                { discard: false },
              );

              const flat = results.flatMap((trialResults) => trialResults.flat());
              const usage = Usages.total(flat.map((result) => result.usage));

              const summarized = variantRun(
                variant.name,
                flat.flatMap((result) => result.scored),
                settings.trials,
                usage,
                (yield* liveMillis) - variantStart,
              );

              yield* bus.emit({
                _tag: "VariantFinished",
                durationMs: summarized.durationMs,
                groups: summarized.groups,
                summary: summarized.summary,
                trials: summarized.trials,
                usage,
                variant: variant.name,
              });

              return summarized;
            }).pipe(
              Effect.withSpan("Eval.variant", {
                attributes: { eval: self.name, variant: variant.name },
              }),
              Effect.provide(variant.layer),
            ),
          { concurrency: "unbounded" },
        );

        const results = Gate.evaluate(self.gates, variantRuns, baselines, Number.POSITIVE_INFINITY);
        yield* Effect.forEach(results, (result) => bus.emit({ ...result, _tag: "GateEvaluated" }), {
          discard: true,
        });
        yield* finish(
          results.every((result) => result.passed),
          false,
        );
      });

      const exit = yield* Effect.uninterruptibleMask((restore) =>
        bus
          .emit({
            _tag: "RunStarted",
            datasetHash,
            eval: self.name,
            git,
            plan: {
              cases: loaded.cases.length,
              invocations: Option.isSome(settings.source.rescoreOf)
                ? 0
                : batches.length * settings.variants.length * settings.trials,
              skipped: loaded.skipped.length,
            },
            rescoreOf: settings.source.rescoreOf,
            sensitive: self.sensitive,
            trials: settings.trials,
            variants: settings.variants.map((variant) => variant.name),
          })
          .pipe(
            Effect.andThen(restore(body)),
            Effect.exit,
            Effect.tap((outcome) => (Exit.isSuccess(outcome) ? Effect.void : finish(false, true))),
            Effect.flatMap((outcome) =>
              bus.close.pipe(
                Effect.exit,
                Effect.map((closed) => ({ closed, outcome })),
              ),
            ),
          ),
      );

      yield* exit.outcome;
      const failedReporters = yield* exit.closed;
      const folded = yield* Effect.orDie(fold(bus.events));
      const run: Run = { ...folded, failedReporters };

      return run;
    }),
  ).pipe(
    Effect.provideService(History.ResolvedBaselines, resolved),
    Effect.provideService(History.ReportBaseline, settings.reportBaseline),
  );
});

const runWith = Effect.fn("Eval.run")(function* runEval<A, O, E, DE, R, DR, SR, ROut, VE, RIn>(
  self: Eval<A, O, E, DE, R, DR, SR>,
  options: Options<ROut, VE, RIn> & { readonly variants: readonly Variant<ROut, VE, RIn>[] },
) {
  const trials = yield* trialsOf(self, options.trials);
  yield* validVariants(options.variants.map((variant) => variant.name));
  const loaded = yield* select(self, options);
  const variantCount = options.variants.length;
  const invocations = batchesOf(self.execution, loaded.cases).length * variantCount * trials;
  const limit = self.budget.confirmAbove;

  if (limit !== undefined && invocations > limit && options.confirmed !== true) {
    return yield* new EvalBudgetExceeded({ limit, planned: invocations });
  }

  const calls = yield* Ref.make(0);
  const { maxCalls } = self.budget;

  const source: Source<A, O, R> = {
    judgements: () => [],
    open: (_variant, _trial) =>
      Effect.exit(self.prepare).pipe(
        Effect.flatMap((prepared) =>
          Exit.isFailure(prepared) && Cause.hasInterrupts(prepared.cause)
            ? Effect.orDie(Effect.failCause(prepared.cause))
            : Effect.succeed(prepared),
        ),
        Effect.map((prepared): Obtain<A, O, R> =>
          Exit.match(prepared, {
            onFailure: (cause) => (batch) =>
              Effect.succeed({
                durationMs: 0,
                outcomes: batch.map(() => Result.fail(`setup: ${failureOf(cause)}`)),
                usage: Usages.empty,
              }),
            onSuccess:
              (runner): Obtain<A, O, R> =>
              (batch, recordUnreported) =>
                Effect.gen(function* obtainLive() {
                  const spent = yield* Ref.make(Usages.empty);
                  const recordedCalls = yield* Ref.make(0);

                  const meter = {
                    record: (usage: Usage) =>
                      Effect.uninterruptible(
                        Ref.update(spent, (current) => Usages.add(current, usage)).pipe(
                          Effect.andThen(Ref.update(recordedCalls, (count) => count + usage.calls)),
                          Effect.andThen(recordUnreported(usage)),
                        ),
                      ),
                  };

                  const begin = yield* liveMillis;

                  const task = (): Effect.Effect<readonly O[], unknown, R> =>
                    Effect.suspend(() => runner(batch));

                  const attempt: Effect.Effect<readonly O[], unknown, R> = Ref.modify(
                    calls,
                    (used): readonly [boolean, number] =>
                      maxCalls !== undefined && used >= maxCalls ? [false, used] : [true, used + 1],
                  ).pipe(
                    Effect.flatMap((allowed) =>
                      allowed
                        ? Ref.get(recordedCalls).pipe(
                            Effect.flatMap((before) =>
                              task().pipe(
                                Effect.onInterrupt(() =>
                                  Ref.get(recordedCalls).pipe(
                                    Effect.flatMap((after) =>
                                      after === before
                                        ? meter.record(Usages.fromRecorded({}))
                                        : Effect.void,
                                    ),
                                  ),
                                ),
                              ),
                            ),
                          )
                        : Effect.fail(exhausted),
                    ),
                  );

                  const timed: Effect.Effect<readonly O[], unknown, R> = Option.match(
                    self.timeout,
                    {
                      onNone: () => attempt,
                      onSome: (duration) => Effect.timeout(attempt, duration),
                    },
                  );

                  const guarded: Effect.Effect<readonly O[], unknown, R> = Option.match(
                    self.retry,
                    {
                      onNone: () => timed,
                      onSome: (schedule) =>
                        Effect.retry(timed, { schedule, while: (error) => error !== exhausted }),
                    },
                  );

                  const exit = yield* withLive(guarded).pipe(
                    Effect.provideService(Meter, meter),
                    Effect.exit,
                  );

                  if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)) {
                    return yield* Effect.orDie(Effect.failCause(exit.cause));
                  }

                  const outcomes = Exit.match(exit, {
                    onFailure: (cause) =>
                      batch.map(() =>
                        Result.fail(
                          Option.contains(Cause.findErrorOption(cause), exhausted)
                            ? BUDGET
                            : failureOf(cause),
                        ),
                      ),
                    onSuccess: (outputs) => outputs.map((output) => Result.succeed(output)),
                  });

                  return {
                    durationMs: (yield* liveMillis) - begin,
                    outcomes,
                    usage: yield* Ref.get(spent),
                  };
                }),
          }),
        ),
      ),
    rescoreOf: Option.none(),
  };

  const settings = {
    baselines: options.baselines ?? [],
    concurrency: options.concurrency ?? concurrencyOf(self.execution),
    reportBaseline: Option.fromNullishOr(options.reportBaseline),
    source,
    trials,
  };

  return yield* execute(self, loaded, { ...settings, variants: options.variants });
});

export type RunError<DE> =
  | DE
  | EvalBudgetExceeded
  | EvalConfigError
  | EvalDatasetError
  | EvalReporterFailed;

export function run<A, O, E, DE, R, DR, SR>(
  self: Eval<A, O, E, DE, R, DR, SR>,
  options?: Options & { readonly variants?: undefined },
): Effect.Effect<Run, RunError<DE>, R | DR | SR>;
export function run<A, O, E, DE, R, DR, SR, ROut, VE, RIn>(
  self: Eval<A, O, E, DE, R, DR, SR>,
  options: Options<ROut, VE, RIn> & { readonly variants: readonly Variant<ROut, VE, RIn>[] },
): Effect.Effect<Run, RunError<DE> | VE, Exclude<R | SR, ROut> | RIn | DR>;
export function run<A, O, E, DE, R, DR, SR, ROut, VE, RIn>(
  self: Eval<A, O, E, DE, R, DR, SR>,
  options: Options<ROut, VE, RIn> = {},
) {
  return options.variants === undefined
    ? runWith(self, { ...options, variants: [Variants.none] })
    : runWith(self, { ...options, variants: options.variants });
}

export const rescoreRun = Effect.fn("Eval.rescoreRun")(function* rescoreStored<
  A,
  O,
  E,
  DE,
  R,
  DR,
  SR,
>(
  self: Eval<A, O, E, DE, R, DR, SR>,
  from: Run,
  selection: Selection & {
    readonly variants?: readonly string[];
    readonly baselines?: readonly ResolvedBaseline[];
    readonly reportBaseline?: History.Selector;
  } = {},
) {
  const loaded = yield* select(self, selection);
  const hashes = yield* hashCases(self, loaded);

  const stored = new Map(
    from.outputs.map((output): readonly [string, StoredOutput] => [
      outputKey(output.variant, output.trial, output.case),
      output,
    ]),
  );

  const decode = (output: StoredOutput): Effect.Effect<Outcome<O>> =>
    Option.match(
      Option.orElse(output.failure, () => output.outputError),
      {
        onNone: () =>
          Option.match(Option.all([self.output, output.output]), {
            onNone: () => Effect.succeed(Result.fail(NO_CODEC)),
            onSome: ([codec, json]) =>
              Schema.decodeUnknownEffect(codec)(json).pipe(
                Effect.match({
                  onFailure: () => Result.fail(UNDECODABLE),
                  onSuccess: (value) => Result.succeed(value),
                }),
              ),
          }),
        onSome: (failure) => Effect.succeed(Result.fail(failure)),
      },
    );

  const isFresh = (output: StoredOutput, id: string) =>
    output.inputHash !== UNHASHED && output.inputHash === hashes.get(id);

  const source: Source<A, O, never> = {
    judgements: (variant, trial, id) =>
      Option.match(Option.fromNullishOr(stored.get(outputKey(variant, trial, id))), {
        onNone: () => [],
        onSome: (output) => (isFresh(output, id) ? output.judgements : []),
      }),
    open: (variant, trial) =>
      Effect.succeed((batch): Effect.Effect<BatchResult<O>> =>
        pipe(
          batch,
          Effect.forEach((input) =>
            Option.match(Option.fromNullishOr(stored.get(outputKey(variant, trial, input.id))), {
              onNone: () => Effect.succeed(Result.fail(NOT_STORED)),
              onSome: (output) =>
                isFresh(output, input.id) ? decode(output) : Effect.succeed(Result.fail(STALE)),
            }),
          ),
          Effect.map((outcomes) => ({ durationMs: 0, outcomes, usage: Usages.empty })),
        ),
      ),
    rescoreOf: Option.some(from.id),
  };

  const storedNames = from.variants.map((variant) => variant.variant);
  const storedSet = new Set(storedNames);
  const chosen = selection.variants ?? storedNames;
  const unknown = chosen.filter((name) => !storedSet.has(name));

  if (unknown.length > 0) {
    return yield* new EvalConfigError({
      message: `The stored run ${from.id} has no variant ${unknown.join(", ")}; it has ${storedNames.join(", ")}.`,
      path: "variants",
    });
  }

  yield* validVariants(chosen);

  const definition: Eval<A, O, E, DE, never, DR, SR> = {
    ...self,
    prepare: Effect.die("rescore does not run the task"),
    sensitive: self.sensitive || from.sensitive,
  };

  return yield* execute(definition, loaded, {
    baselines: selection.baselines ?? [],
    concurrency: concurrencyOf(self.execution),
    reportBaseline: Option.fromNullishOr(selection.reportBaseline),
    source,
    trials: from.trials,
    variants: chosen.map((name) => Variants.make(name, Layer.empty)),
  });
});

export const rescore = Effect.fn("Eval.rescore")(function* rescoreEval<A, O, E, DE, R, DR, SR>(
  self: Eval<A, O, E, DE, R, DR, SR>,
  options: Selection & {
    readonly from: History.Selector;
    readonly variants?: readonly string[];
    readonly baselines?: readonly ResolvedBaseline[];
    readonly reportBaseline?: History.Selector;
  },
) {
  const from = yield* History.load(self.name, options.from);

  return yield* rescoreRun(self, from, options);
});

export const check = (self: Run) => Gate.check(self.gates, { sensitive: self.sensitive });
