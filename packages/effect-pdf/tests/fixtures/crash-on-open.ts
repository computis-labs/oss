import { NodeRuntime, NodeWorkerRunner } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { RpcGroup, RpcServer } from "effect/rpc";
import { workerData } from "node:worker_threads";
import { OpenRpc } from "../../src/rpc.ts";

const OpenRpcs = RpcGroup.make(OpenRpc);

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
