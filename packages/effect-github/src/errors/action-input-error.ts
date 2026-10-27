import { Schema } from "effect";

export const ActionInputErrorReason = {
  InvalidType: "InvalidType",
  Missing: "Missing",
  ParseError: "ParseError",
} as const;

export class ActionInputError extends Schema.TaggedError<ActionInputError>()("ActionInputError", {
  cause: Schema.optionalKey(Schema.Defect()),
  name: Schema.String,
  reason: Schema.Literals(Object.values(ActionInputErrorReason)),
  value: Schema.optionalKey(Schema.Unknown),
}) {
  override get message() {
    if (this.reason === ActionInputErrorReason.InvalidType) {
      return `Input "${this.name}" has invalid type`;
    }

    return this.reason === ActionInputErrorReason.Missing
      ? `Input required and not supplied: ${this.name}`
      : `Failed to parse input "${this.name}"`;
  }
}
