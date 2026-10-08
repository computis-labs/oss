import { Data, Effect } from "effect";

export class BenchmarkError extends Data.TaggedError("BenchmarkError")<{
  readonly cause: unknown;
}> {
  readonly code = "BENCHMARK";
}

export const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ catch: (cause) => new BenchmarkError({ cause }), try: run });

export const formatNumber = (value: number, digits: number) =>
  value.toLocaleString("it-IT", { maximumFractionDigits: digits, minimumFractionDigits: digits });

export const median = (values: readonly number[]) =>
  values.toSorted((left, right) => left - right)[Math.floor(values.length / 2)] ?? Number.NaN;
