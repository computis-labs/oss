import { NodeServices, NodeWorker } from "@effect/platform-node";
import { Worker } from "node:worker_threads";
import { Layer } from "effect";
import { PdfEngine, pdfWorkerEntry } from "../../src/engine.ts";

export const nodeWorkers = (spawn = () => new Worker(pdfWorkerEntry)) => NodeWorker.layer(spawn);

export const pdfEngineLayer = PdfEngine.layer({ size: 2 }).pipe(
  Layer.provide(nodeWorkers()),
  Layer.provideMerge(NodeServices.layer),
);
