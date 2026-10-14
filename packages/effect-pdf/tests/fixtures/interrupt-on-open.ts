import { NodeRuntime, NodeWorkerRunner } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { RpcServer } from "effect/rpc";
import { workerData } from "node:worker_threads";
import { PdfRpcs } from "../../src/rpc.ts";

const OpenRpcs = PdfRpcs.omit(
  "AddSignatureField",
  "Classify",
  "Fields",
  "Find",
  "PageImages",
  "Render",
  "Save",
  "SetFields",
  "Text",
);

NodeRuntime.runMain(
  Layer.launch(
    RpcServer.layer(OpenRpcs).pipe(
      Layer.provide(
        OpenRpcs.toLayer({
          Close: () => Effect.void,
          Open: () =>
            Effect.sync(() => Atomics.add(new Int32Array(workerData), 0, 1)).pipe(
              Effect.andThen(Effect.interrupt),
            ),
        }),
      ),
      Layer.provide(RpcServer.layerProtocolWorkerRunner),
      Layer.provide(NodeWorkerRunner.layer),
    ),
  ),
);
