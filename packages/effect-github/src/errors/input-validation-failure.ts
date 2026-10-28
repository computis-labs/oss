import { Schema } from "effect";

export const InputValidationFailureReason = {
  InvalidJson: "InvalidJson",
  InvalidType: "InvalidType",
  MissingRequired: "MissingRequired",
  SchemaValidation: "SchemaValidation",
} as const;

export class InputValidationFailure extends Schema.TaggedError<InputValidationFailure>()(
  "InputValidationFailure",
  {
    cause: Schema.optionalKey(Schema.Defect()),
    input: Schema.String,
    message: Schema.String,
    reason: Schema.Literals(Object.values(InputValidationFailureReason)),
    value: Schema.String,
  },
) {
  readonly code = "INPUT_VALIDATION_FAILURE";

  get displayMessage() {
    return `Input '${this.input}' is invalid: ${this.message}`;
  }
}
