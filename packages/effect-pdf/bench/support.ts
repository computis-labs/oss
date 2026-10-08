import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeWorker from "@effect/platform-node/NodeWorker";
import { Worker } from "node:worker_threads";
import { Data, Effect, Layer } from "effect";
import { PdfEngine, pdfWorkerEntry } from "../src/engine.ts";

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

export const nodePdfEngine = (options: { readonly size?: number } = {}) =>
  PdfEngine.layer(options).pipe(
    Layer.provide(NodeWorker.layer(() => new Worker(pdfWorkerEntry))),
    Layer.provide(NodeServices.layer),
  );

export const nodePdfEngineInProcess = PdfEngine.layerInProcess.pipe(
  Layer.provide(NodeServices.layer),
);
