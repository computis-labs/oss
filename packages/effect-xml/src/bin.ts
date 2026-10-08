#!/usr/bin/env node
import { Console, Data, Effect } from "effect";
import { main } from "./cli.ts";

const onBun = process.versions["bun"] !== undefined;

class PlatformMissing extends Data.TaggedError("PlatformMissing")<{
  readonly platform: string;
}> {
  readonly code = "PLATFORM_MISSING";
}

const loadPlatform = <A>(platform: string, load: () => Promise<A>) =>
  Effect.tryPromise({ catch: () => new PlatformMissing({ platform }), try: load });

const runOnBun = Effect.gen(function* runOnBunProgram() {
  const [runtime, services] = yield* loadPlatform(
    "@effect/platform-bun",
    async () =>
      await Promise.all([
        import("@effect/platform-bun/BunRuntime"),
        import("@effect/platform-bun/BunServices"),
      ]),
  );
  yield* Effect.sync(() => {
    runtime.runMain(main.pipe(Effect.provide(services.layer)), { disableErrorReporting: true });
  });
});

const runOnNode = Effect.gen(function* runOnNodeProgram() {
  const [runtime, services] = yield* loadPlatform(
    "@effect/platform-node",
    async () =>
      await Promise.all([
        import("@effect/platform-node/NodeRuntime"),
        import("@effect/platform-node/NodeServices"),
      ]),
  );
  yield* Effect.sync(() => {
    runtime.runMain(main.pipe(Effect.provide(services.layer)), { disableErrorReporting: true });
  });
});

Effect.runFork(
  (onBun ? runOnBun : runOnNode).pipe(
    Effect.catchTag("PlatformMissing", ({ platform }) =>
      Console.error(
        `The effect-xml CLI runs on an Effect platform package: install ${platform} next to @computis/effect-xml.`,
      ).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1;
          }),
        ),
      ),
    ),
  ),
);
