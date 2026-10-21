import { Array as Arr, Data } from "effect";

export type Execution = Data.TaggedEnum<{
  PerCase: { readonly concurrency: number };
  Batched: { readonly size: number; readonly concurrency: number };
  Whole: Record<never, never>;
}>;

const { $is, $match, Batched, PerCase, Whole } = Data.taggedEnum<Execution>();

export type PerCaseExecution = Data.TaggedEnum.Value<Execution, "PerCase">;
export type BatchedExecution = Data.TaggedEnum.Value<Execution, "Batched">;
export type WholeExecution = Data.TaggedEnum.Value<Execution, "Whole">;

export const perCase = (options: { readonly concurrency?: number } = {}): PerCaseExecution =>
  PerCase({ concurrency: options.concurrency ?? 1 });

export const batched = (
  size: number,
  options: { readonly concurrency?: number } = {},
): BatchedExecution => Batched({ concurrency: options.concurrency ?? 1, size });

export const whole: WholeExecution = Whole();

export const isPerCase = $is("PerCase");

export const batchesOf = <A>(
  execution: Execution,
  items: readonly A[],
): readonly Arr.NonEmptyReadonlyArray<A>[] =>
  $match(execution, {
    Batched: ({ size }) => Arr.chunksOf(items, size),
    PerCase: () => items.map((item) => Arr.of(item)),
    Whole: () => (Arr.isReadonlyArrayNonEmpty(items) ? [items] : []),
  });

export const concurrencyOf = (execution: Execution) =>
  $match(execution, {
    Batched: ({ concurrency }) => concurrency,
    PerCase: ({ concurrency }) => concurrency,
    Whole: () => 1,
  });
