import { Schema } from "effect";

export const ActionInputErrorReason = {
  InvalidType: "InvalidType",
  Missing: "Missing",
  ParseError: "ParseError",
} as const;

const messages = {
  [ActionInputErrorReason.InvalidType]: (name: string) => `Input "${name}" has invalid type`,
  [ActionInputErrorReason.Missing]: (name: string) => `Input required and not supplied: ${name}`,
  [ActionInputErrorReason.ParseError]: (name: string) => `Failed to parse input "${name}"`,
};

export class ActionInputError extends Schema.TaggedError<ActionInputError>()("ActionInputError", {
  cause: Schema.optionalKey(Schema.Defect()),
  name: Schema.String,
  reason: Schema.Literals(Object.values(ActionInputErrorReason)),
  value: Schema.optionalKey(Schema.Unknown),
}) {
  override get message() {
    return messages[this.reason](this.name);
  }
}
