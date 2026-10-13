import { NodeRuntime, NodeWorkerRunner } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { RpcServer } from "effect/rpc";
import { workerData } from "node:worker_threads";
import { PdfRpcs } from "../../src/rpc.ts";

// Receive a real Open request, including its transferred buffer, then exit
// before replying. Subsequent workers use the normal PDF worker entry.
const OpenRpcs = PdfRpcs.omit(
  "AddSignatureField",
  "Classify",
  "Close",
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
          Open: () =>
            Effect.sync(() => {
              Atomics.add(new Int32Array(workerData), 0, 1);
              process.exit(1);
            }),
        }),
      ),
      Layer.provide(RpcServer.layerProtocolWorkerRunner),
      Layer.provide(NodeWorkerRunner.layer),
    ),
  ),
);
