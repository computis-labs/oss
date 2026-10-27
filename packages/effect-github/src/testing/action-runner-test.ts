import { Effect, Layer, Predicate, Redacted } from "effect";
import type { Schema } from "effect";
import { ActionRunner } from "../action-runner.ts";
import type { InputOptions } from "../action-runner.ts";
import { ActionInputError, ActionInputErrorReason } from "../errors/action-input-error.ts";

export interface LogEntry {
  readonly level: "debug" | "info" | "warning" | "error" | "notice";
  readonly message: string;
}

const trueInputs = new Set(["true", "True", "TRUE"]);
const falseInputs = new Set(["false", "False", "FALSE"]);

const messageText = (message: string | Error) =>
  Predicate.isString(message) ? message : message.message;

export const make = (
  options: {
    readonly inputs?: Readonly<Record<string, string>>;
    readonly state?: Readonly<Record<string, string>>;
    readonly idToken?: string;
  } = {},
) => {
  const inputs = new Map(Object.entries(options.inputs ?? {}));

  const recording = {
    failures: Array.of<string>(),
    groups: Array.of<string>(),
    logs: Array.of<LogEntry>(),
    outputs: new Map<string, Schema.Json>(),
    paths: Array.of<string>(),
    secrets: Array.of<string>(),
    state: new Map(Object.entries(options.state ?? {})),
    variables: new Map<string, string>(),
  };

  const readInput = Effect.fn("ActionRunnerTest.readInput")(function* readInput(
    name: string,
    inputOptions: InputOptions = {},
  ) {
    const value = inputs.get(name) ?? "";

    if (inputOptions.required === true && value === "") {
      return yield* new ActionInputError({ name, reason: ActionInputErrorReason.Missing });
    }

    return inputOptions.trimWhitespace === false ? value : value.trim();
  });

  const log = (level: LogEntry["level"]) => (message: string | Error) =>
    Effect.sync(() => {
      recording.logs.push({ level, message: messageText(message) });
    });

  const layer = Layer.succeed(ActionRunner, {
    addPath: (path) =>
      Effect.sync(() => {
        recording.paths.push(path);
      }),
    debug: log("debug"),
    endGroup: () =>
      Effect.sync(() => {
        recording.groups.pop();
      }),
    error: log("error"),
    exportVariable: (name, value) =>
      Effect.sync(() => {
        recording.variables.set(name, value);
      }),
    getBooleanInput: Effect.fn("TestActionRunner.getBooleanInput")(function* getBooleanInput(
      name: string,
      inputOptions?: InputOptions,
    ) {
      const value = yield* readInput(name, inputOptions).pipe(
        Effect.mapError(
          (cause) =>
            new ActionInputError({ cause, name, reason: ActionInputErrorReason.InvalidType }),
        ),
      );

      if (trueInputs.has(value)) {
        return true;
      }

      if (falseInputs.has(value)) {
        return false;
      }

      return yield* new ActionInputError({
        name,
        reason: ActionInputErrorReason.InvalidType,
        value,
      });
    }),
    getIDToken: () => Effect.succeed(Redacted.make(options.idToken ?? "test-oidc-token")),
    getInput: readInput,
    getMultilineInput: Effect.fn("ActionRunnerTest.getMultilineInput")(function* getMultilineInput(
      name: string,
      inputOptions?: InputOptions,
    ) {
      const value = yield* readInput(name, { ...inputOptions, trimWhitespace: false });

      return value
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => (inputOptions?.trimWhitespace === false ? line : line.trim()));
    }),
    getState: (name) => Effect.sync(() => recording.state.get(name) ?? ""),
    group: <A, E, R>(name: string, fn: () => Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          recording.groups.push(name);
        }),
        fn,
        () =>
          Effect.sync(() => {
            recording.groups.pop();
          }),
      ).pipe(Effect.withSpan("ActionRunnerTest.group", { attributes: { group: name } })),
    info: log("info"),
    notice: log("notice"),
    saveState: (name, value) =>
      Effect.sync(() => {
        recording.state.set(name, Predicate.isString(value) ? value : JSON.stringify(value));
      }),
    setFailed: (message) =>
      Effect.sync(() => {
        recording.failures.push(messageText(message));
      }),
    setOutput: (name, value) =>
      Effect.sync(() => {
        recording.outputs.set(name, value);
      }),
    setSecret: (secret) =>
      Effect.sync(() => {
        recording.secrets.push(secret);
      }),
    startGroup: (name) =>
      Effect.sync(() => {
        recording.groups.push(name);
      }),
    warning: log("warning"),
  });

  return { layer, recording };
};

export const { layer } = make();
