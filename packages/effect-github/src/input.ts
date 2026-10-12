import { Effect, Schema, SchemaGetter, SchemaTransformation } from "effect";
import { ActionRunner } from "./action-runner.ts";
import {
  InputValidationFailure,
  InputValidationFailureReason,
} from "./errors/input-validation-failure.ts";

const yamlTrue: ReadonlySet<string> = new Set(["true", "yes", "on", "1"]);

export const YamlBoolean: Schema.Codec<boolean, string> = Schema.String.pipe(
  Schema.decodeTo(Schema.String, SchemaTransformation.toLowerCase()),
  Schema.decodeTo(
    Schema.Literals(["true", "yes", "on", "1", "false", "no", "off", "0", ""]),
    SchemaTransformation.passthroughSupertype(),
  ),
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((literal) => yamlTrue.has(literal)),
    encode: SchemaGetter.transform((value) => (value ? "true" : "false")),
  }),
);

export const raw = Effect.fn("Input.raw")(function* raw(name: string) {
  const runner = yield* ActionRunner;
  return yield* runner.getInput(name).pipe(Effect.orDie);
});

export const parse = Effect.fn("Input.parse")(function* parse<S extends Schema.Top>(
  name: string,
  schema: S,
) {
  const value = yield* raw(name);
  return yield* Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      (cause) =>
        new InputValidationFailure({
          cause,
          input: name,
          message: cause.message,
          reason: InputValidationFailureReason.SchemaValidation,
          value,
        }),
    ),
  );
});

export const string = (name: string) => parse(name, Schema.String);

export const nonEmptyString = (name: string) => parse(name, Schema.NonEmptyString);

export const integer = (name: string) => parse(name, Schema.NumberFromString.check(Schema.isInt()));

export const number = (name: string) => parse(name, Schema.NumberFromString);

export const boolean = (name: string) => parse(name, YamlBoolean);

export const secret = (name: string) =>
  parse(name, Schema.RedactedFromValue(Schema.NonEmptyString));

export const json = <S extends Schema.Top>(name: string, schema: S) =>
  parse(name, Schema.fromJsonString(schema));
