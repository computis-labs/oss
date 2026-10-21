import { Effect, Option, pipe } from "effect";
import type { Array as Arr, Duration, Schedule, Schema, Scope } from "effect";
import type { Case, Dataset } from "./dataset.ts";
import { perCase } from "./execution.ts";
import type { BatchedExecution, Execution, PerCaseExecution, WholeExecution } from "./execution.ts";
import type { Gate } from "./gate.ts";
import type { Scorer } from "./scorer.ts";

export interface Budget {
  readonly maxCalls?: number;
  readonly confirmAbove?: number;
}

type SetupOf<S, SetupE, SetupR> = [S] extends [undefined]
  ? { readonly setup?: Effect.Effect<S, SetupE, SetupR | Scope.Scope> }
  : { readonly setup: Effect.Effect<S, SetupE, SetupR | Scope.Scope> };

interface Shared<A, O, DE, DR, SR> {
  readonly name: string;
  readonly dataset: Dataset<A, DE, DR>;
  readonly score: Scorer<A, O, SR>;
  readonly output?: Schema.Codec<O, Schema.Json>;
  readonly hash?: (input: A) => string;
  readonly gates?: readonly Gate[];
  readonly trials?: number;
  readonly timeout?: Duration.Input;
  readonly retry?: Schedule.Schedule<unknown>;
  readonly budget?: Budget;
  readonly sensitive?: boolean;
}

type Common<A, O, S, DE, DR, SR, SetupE, SetupR> = Shared<A, O, DE, DR, SR> &
  SetupOf<S, SetupE, SetupR>;

export type PerCaseDefinition<
  A,
  O,
  S,
  E,
  DE,
  R,
  DR = never,
  SR = never,
  SetupE = E,
  SetupR = R,
> = Common<A, O, S, DE, DR, SR, SetupE, SetupR> & {
  readonly execution?: PerCaseExecution;
  readonly task: (input: Case<A>, setup: S) => Effect.Effect<O, E, R>;
};

export type BatchDefinition<
  A,
  O,
  S,
  E,
  DE,
  R,
  DR = never,
  SR = never,
  SetupE = E,
  SetupR = R,
> = Common<A, O, S, DE, DR, SR, SetupE, SetupR> & {
  readonly execution: BatchedExecution | WholeExecution;
  readonly task: (
    inputs: Arr.NonEmptyReadonlyArray<Case<A>>,
    setup: S,
  ) => Effect.Effect<readonly O[], E, R>;
};

export type BatchRunner<A, O, E, R> = (
  inputs: Arr.NonEmptyReadonlyArray<Case<A>>,
) => Effect.Effect<readonly O[], E, R>;

export interface Eval<A, O, E = never, DE = never, R = never, DR = never, SR = never> {
  readonly name: string;
  readonly dataset: Dataset<A, DE, DR>;
  readonly execution: Execution;
  readonly prepare: Effect.Effect<BatchRunner<A, O, E, R>, E, R | Scope.Scope>;
  readonly score: Scorer<A, O, SR>;
  readonly output: Option.Option<Schema.Codec<O, Schema.Json>>;
  readonly hash: Option.Option<(input: A) => string>;
  readonly gates: readonly Gate[];
  readonly trials: number;
  readonly timeout: Option.Option<Duration.Input>;
  readonly retry: Option.Option<Schedule.Schedule<unknown>>;
  readonly budget: Budget;
  readonly sensitive: boolean;
}

const build = <A, O, S, E, DE, R, DR, SR, SetupE, SetupR>(
  definition: Common<A, O, S, DE, DR, SR, SetupE, SetupR>,
  execution: Execution,
  runner: (setup: S) => BatchRunner<A, O, E, R>,
): Eval<A, O, E | SetupE, DE, R | SetupR, DR, SR> => ({
  budget: definition.budget ?? {},
  dataset: definition.dataset,
  execution,
  gates: definition.gates ?? [],
  hash: Option.fromNullishOr(definition.hash),
  name: definition.name,
  output: Option.fromNullishOr(definition.output),
  prepare: Option.match(
    Option.fromNullishOr<Effect.Effect<S, SetupE, SetupR | Scope.Scope> | undefined>(
      definition.setup,
    ),
    {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: SetupOf makes setup optional only when S is undefined, so the task receives undefined.
      onNone: () => Effect.sync(() => runner(undefined as S)),
      onSome: (setup) => setup.pipe(Effect.map(runner)),
    },
  ),
  retry: Option.fromNullishOr(definition.retry),
  score: definition.score,
  sensitive: (definition.sensitive ?? false) || definition.dataset.sensitive,
  timeout: Option.fromNullishOr(definition.timeout),
  trials: definition.trials ?? 1,
});

export const make = <
  A,
  O,
  S = undefined,
  E = never,
  DE = never,
  R = never,
  DR = never,
  SR = never,
  SetupE = E,
  SetupR = R,
>(
  definition: PerCaseDefinition<A, O, S, E, DE, R, DR, SR, SetupE, SetupR>,
): Eval<A, O, E | SetupE, DE, R | SetupR, DR, SR> =>
  build(
    definition,
    definition.execution ?? perCase(),
    (setup) => (inputs) =>
      pipe(
        inputs,
        Effect.forEach((input) => definition.task(input, setup)),
      ),
  );

export const makeBatched = <
  A,
  O,
  S = undefined,
  E = never,
  DE = never,
  R = never,
  DR = never,
  SR = never,
  SetupE = E,
  SetupR = R,
>(
  definition: BatchDefinition<A, O, S, E, DE, R, DR, SR, SetupE, SetupR>,
): Eval<A, O, E | SetupE, DE, R | SetupR, DR, SR> =>
  build(definition, definition.execution, (setup) => (inputs) => definition.task(inputs, setup));
