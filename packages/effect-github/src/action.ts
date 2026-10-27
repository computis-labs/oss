import { setFailed } from "@actions/core";
import { thrownMessage } from "./thrown-message.ts";
import { Cause, Effect, Layer, Logger, ManagedRuntime, Option } from "effect";
import type { Redacted } from "effect";
import { ActionClient } from "./action-client.ts";
import { ActionContext } from "./action-context.ts";
import { ActionRunner } from "./action-runner.ts";
import { ActionSummary } from "./action-summary.ts";
import { isActionFailure } from "./errors/action-failure.ts";
import { PlatformMissing } from "./errors/platform-missing.ts";

export type ActionRequirements = ActionRunner | ActionContext | ActionClient | ActionSummary;

export const layer = (token: Redacted.Redacted): Layer.Layer<ActionRequirements> =>
  Layer.mergeAll(
    ActionRunner.layer,
    ActionContext.layer,
    ActionClient.layer(token),
    ActionSummary.layer,
  );

export const layerConfig = Layer.mergeAll(
  ActionRunner.layer,
  ActionContext.layer,
  ActionClient.layerConfig,
  ActionSummary.layer,
);

export const runMain = <A, E>(
  effect: Effect.Effect<A, E, ActionRequirements>,
  options: {
    readonly disableErrorReporting?: boolean;
    readonly disablePrettyLogger?: boolean;
    readonly token?: Redacted.Redacted;
  } = {},
) => {
  const program = effect.pipe(
    Effect.provide(options.token === undefined ? layerConfig : layer(options.token)),
    Effect.tapCause(
      Effect.fn("Action.reportFailure")(function* reportFailure<F>(cause: Cause.Cause<F>) {
        if (Cause.hasInterruptsOnly(cause)) {
          return;
        }

        if (options.disableErrorReporting !== true) {
          yield* Effect.logError(cause);
        }

        setFailed(
          Option.match(Cause.findErrorOption(cause), {
            onNone: () => Cause.pretty(cause),
            onSome: (error) =>
              isActionFailure(error)
                ? error.displayMessage
                : thrownMessage(error, Cause.pretty(cause)),
          }),
        );
      }),
    ),
    Effect.provide(
      options.disablePrettyLogger === true ? Layer.empty : Logger.layer([Logger.consolePretty()]),
    ),
  );

  Effect.runFork(
    Effect.tryPromise({
      catch: () => new PlatformMissing({ platform: "@effect/platform-node" }),
      try: async () => await import("@effect/platform-node/NodeRuntime"),
    }).pipe(
      Effect.flatMap((NodeRuntime) =>
        Effect.sync(() => {
          NodeRuntime.runMain(program, { disableErrorReporting: true });
        }),
      ),
      Effect.catchTag("PlatformMissing", (missing) =>
        Effect.sync(() => {
          setFailed(missing.message);
        }),
      ),
    ),
  );
};

export const makeRuntime = (token: Redacted.Redacted) => ManagedRuntime.make(layer(token));
