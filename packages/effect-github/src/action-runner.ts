import * as core from "@actions/core";
import { thrownMessage } from "./thrown-message.ts";
import { Context, Effect, Layer, Redacted } from "effect";
import type { Schema } from "effect";
import { ActionInputError, ActionInputErrorReason } from "./errors/action-input-error.ts";
import { ActionOIDCError, ActionOIDCErrorReason } from "./errors/action-oidc-error.ts";

export interface InputOptions {
  readonly required?: boolean;
  readonly trimWhitespace?: boolean;
}

export type AnnotationProperties = core.AnnotationProperties;

export interface ActionRunnerApi {
  readonly getInput: (
    name: string,
    options?: InputOptions,
  ) => Effect.Effect<string, ActionInputError>;
  readonly getMultilineInput: (
    name: string,
    options?: InputOptions,
  ) => Effect.Effect<readonly string[], ActionInputError>;
  readonly getBooleanInput: (
    name: string,
    options?: InputOptions,
  ) => Effect.Effect<boolean, ActionInputError>;
  readonly setOutput: (name: string, value: Schema.Json) => Effect.Effect<void>;
  readonly debug: (message: string) => Effect.Effect<void>;
  readonly info: (message: string) => Effect.Effect<void>;
  readonly warning: (
    message: string | Error,
    properties?: AnnotationProperties,
  ) => Effect.Effect<void>;
  readonly error: (
    message: string | Error,
    properties?: AnnotationProperties,
  ) => Effect.Effect<void>;
  readonly notice: (
    message: string | Error,
    properties?: AnnotationProperties,
  ) => Effect.Effect<void>;
  readonly startGroup: (name: string) => Effect.Effect<void>;
  readonly endGroup: () => Effect.Effect<void>;
  readonly group: <A, E, R>(
    name: string,
    fn: () => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly exportVariable: (name: string, value: string) => Effect.Effect<void>;
  readonly addPath: (path: string) => Effect.Effect<void>;
  readonly setSecret: (secret: string) => Effect.Effect<void>;
  readonly saveState: (name: string, value: Schema.Json) => Effect.Effect<void>;
  readonly getState: (name: string) => Effect.Effect<string>;
  readonly setFailed: (message: string | Error) => Effect.Effect<void>;
  readonly getIDToken: (audience?: string) => Effect.Effect<Redacted.Redacted, ActionOIDCError>;
}

const readInput = Effect.fn("ActionRunner.readInput")(function* readInput<A>(
  name: string,
  read: () => A,
) {
  return yield* Effect.try({
    catch: (cause) => new ActionInputError({ cause, name, reason: ActionInputErrorReason.Missing }),
    try: read,
  });
});

export class ActionRunner extends Context.Service<ActionRunner, ActionRunnerApi>()(
  "@computis/effect-github/ActionRunner",
) {
  static readonly layer = Layer.succeed(ActionRunner, {
    addPath: (path) =>
      Effect.sync(() => {
        core.addPath(path);
      }),
    debug: (message) =>
      Effect.sync(() => {
        core.debug(message);
      }),
    endGroup: () =>
      Effect.sync(() => {
        core.endGroup();
      }),
    error: (message, properties) =>
      Effect.sync(() => {
        core.error(message, properties);
      }),
    exportVariable: (name, value) =>
      Effect.sync(() => {
        core.exportVariable(name, value);
      }),
    getBooleanInput: Effect.fn("ActionRunner.getBooleanInput")(function* getBooleanInput(
      name: string,
      options?: InputOptions,
    ) {
      return yield* Effect.try({
        catch: (cause) =>
          new ActionInputError({ cause, name, reason: ActionInputErrorReason.InvalidType }),
        try: () => core.getBooleanInput(name, options),
      });
    }),
    getIDToken: Effect.fn("ActionRunner.getIDToken")(function* getIDToken(audience?: string) {
      return yield* Effect.tryPromise({
        catch: (cause) =>
          new ActionOIDCError({
            cause,
            description: thrownMessage(cause, "the token request was rejected"),
            reason: ActionOIDCErrorReason.RequestFailed,
          }),
        try: async () => Redacted.make(await core.getIDToken(audience)),
      });
    }),
    getInput: (name, options) => readInput(name, () => core.getInput(name, options)),
    getMultilineInput: (name, options) =>
      readInput(name, () => core.getMultilineInput(name, options)),
    getState: (name) => Effect.sync(() => core.getState(name)),
    group: <A, E, R>(name: string, fn: () => Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          core.startGroup(name);
        }),
        fn,
        () =>
          Effect.sync(() => {
            core.endGroup();
          }),
      ).pipe(Effect.withSpan("ActionRunner.group", { attributes: { group: name } })),
    info: (message) =>
      Effect.sync(() => {
        core.info(message);
      }),
    notice: (message, properties) =>
      Effect.sync(() => {
        core.notice(message, properties);
      }),
    saveState: (name, value) =>
      Effect.sync(() => {
        core.saveState(name, value);
      }),
    setFailed: (message) =>
      Effect.sync(() => {
        core.setFailed(message);
      }),
    setOutput: (name, value) =>
      Effect.sync(() => {
        core.setOutput(name, value);
      }),
    setSecret: (secret) =>
      Effect.sync(() => {
        core.setSecret(secret);
      }),
    startGroup: (name) =>
      Effect.sync(() => {
        core.startGroup(name);
      }),
    warning: (message, properties) =>
      Effect.sync(() => {
        core.warning(message, properties);
      }),
  });
}

const runner = Effect.service(ActionRunner);

export const getInput = (name: string, options?: InputOptions) =>
  runner.pipe(Effect.flatMap((service) => service.getInput(name, options)));

export const getMultilineInput = (name: string, options?: InputOptions) =>
  runner.pipe(Effect.flatMap((service) => service.getMultilineInput(name, options)));

export const getBooleanInput = (name: string, options?: InputOptions) =>
  runner.pipe(Effect.flatMap((service) => service.getBooleanInput(name, options)));

export const setOutput = (name: string, value: Schema.Json) =>
  runner.pipe(Effect.flatMap((service) => service.setOutput(name, value)));

export const debug = (message: string) =>
  runner.pipe(Effect.flatMap((service) => service.debug(message)));

export const info = (message: string) =>
  runner.pipe(Effect.flatMap((service) => service.info(message)));

export const warning = (message: string | Error, properties?: AnnotationProperties) =>
  runner.pipe(Effect.flatMap((service) => service.warning(message, properties)));

export const error = (message: string | Error, properties?: AnnotationProperties) =>
  runner.pipe(Effect.flatMap((service) => service.error(message, properties)));

export const notice = (message: string | Error, properties?: AnnotationProperties) =>
  runner.pipe(Effect.flatMap((service) => service.notice(message, properties)));

export const startGroup = (name: string) =>
  runner.pipe(Effect.flatMap((service) => service.startGroup(name)));

export const endGroup = runner.pipe(Effect.flatMap((service) => service.endGroup()));

export const group = <A, E, R>(name: string, fn: () => Effect.Effect<A, E, R>) =>
  runner.pipe(Effect.flatMap((service) => service.group(name, fn)));

export const exportVariable = (name: string, value: string) =>
  runner.pipe(Effect.flatMap((service) => service.exportVariable(name, value)));

export const addPath = (path: string) =>
  runner.pipe(Effect.flatMap((service) => service.addPath(path)));

export const setSecret = (secret: string) =>
  runner.pipe(Effect.flatMap((service) => service.setSecret(secret)));

export const saveState = (name: string, value: Schema.Json) =>
  runner.pipe(Effect.flatMap((service) => service.saveState(name, value)));

export const getState = (name: string) =>
  runner.pipe(Effect.flatMap((service) => service.getState(name)));

export const setFailed = (message: string | Error) =>
  runner.pipe(Effect.flatMap((service) => service.setFailed(message)));

export const getIDToken = (audience?: string) =>
  runner.pipe(Effect.flatMap((service) => service.getIDToken(audience)));

export const { layer } = ActionRunner;
