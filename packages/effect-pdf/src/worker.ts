import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeWorkerRunner from "@effect/platform-node/NodeWorkerRunner";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcServer from "effect/rpc/RpcServer";
import * as RpcWorker from "effect/rpc/RpcWorker";
import { PdfiumRuntime } from "./pdfium.ts";
import { PdfiumWasm, PdfWorkerInit } from "./pdfium-wasm.ts";
import { PdfRpcs } from "./rpc.ts";
import { PdfRpcHandlers } from "./server.ts";

const protocol = RpcServer.layerProtocolWorkerRunner.pipe(Layer.provide(NodeWorkerRunner.layer));

const wasmFromParent = Layer.effect(
  PdfiumWasm,
  RpcWorker.initialMessage(PdfWorkerInit).pipe(
    Effect.map(({ wasm }) => ({ module: wasm })),
    Effect.orDie,
  ),
).pipe(Layer.provide(protocol));

NodeRuntime.runMain(
  RpcServer.layer(PdfRpcs).pipe(
    Layer.provide(PdfRpcHandlers),
    Layer.provide(PdfiumRuntime.layer),
    Layer.provide(wasmFromParent),
    Layer.provide(protocol),
    Layer.launch,
  ),
);
