import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import type * as WorkerRunner from "effect/workers/WorkerRunner";
import { PdfWorkerServer } from "./server.ts";

const onBun = process.versions["bun"] !== undefined;

const isModuleNotFound = Schema.is(
  Schema.Struct({ code: Schema.Literal("ERR_MODULE_NOT_FOUND"), message: Schema.String }),
);

class PlatformUnavailable extends Data.TaggedError("PlatformUnavailable")<{
  readonly cause: unknown;
  readonly platform: string;
  readonly reason: "load" | "missing";
}> {
  readonly code = "PLATFORM_UNAVAILABLE";
}

interface LoadedPlatform {
  readonly runMain: ReturnType<typeof Runtime.makeRunMain>;
  readonly runner: Layer.Layer<WorkerRunner.WorkerRunnerPlatform>;
}

const loadPlatform = (
  platform: string,
  load: () => Promise<LoadedPlatform>,
): Effect.Effect<LoadedPlatform, PlatformUnavailable> =>
  Effect.tryPromise({
    catch: (cause) =>
      new PlatformUnavailable({
        cause,
        platform,
        reason:
          isModuleNotFound(cause) && cause.message.includes(`'${platform}'`) ? "missing" : "load",
      }),
    try: load,
  });

const failWorker = (message: string, ...details: readonly unknown[]) =>
  Console.error(message, ...details).pipe(
    Effect.andThen(
      Effect.sync(() => {
        process.exitCode = 1;
      }),
    ),
  );

const hostPlatform = onBun
  ? loadPlatform("@effect/platform-bun", async () => {
      const [runtime, runner] = await Promise.all([
        import("@effect/platform-bun/BunRuntime"),
        import("@effect/platform-bun/BunWorkerRunner"),
      ]);
      return { runMain: runtime.runMain, runner: runner.layer };
    })
  : loadPlatform("@effect/platform-node", async () => {
      const [runtime, runner] = await Promise.all([
        import("@effect/platform-node/NodeRuntime"),
        import("@effect/platform-node/NodeWorkerRunner"),
      ]);
      return { runMain: runtime.runMain, runner: runner.layer };
    });

Effect.runFork(
  hostPlatform.pipe(
    Effect.flatMap(({ runMain, runner }) =>
      Effect.sync(() => {
        runMain(Layer.launch(PdfWorkerServer.pipe(Layer.provide(runner))));
      }),
    ),
    Effect.catchTag("PlatformUnavailable", ({ cause, platform, reason }) =>
      reason === "missing"
        ? failWorker(
            `The effect-pdf worker runs on an Effect platform package: install ${platform} next to @computis/effect-pdf.`,
          )
        : failWorker(`The effect-pdf worker could not load ${platform}:`, cause),
    ),
  ),
);
