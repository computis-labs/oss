import { Schema } from "effect";

export const ActionContextErrorReason = {
  InvalidPayload: "InvalidPayload",
  InvalidRepo: "InvalidRepo",
  MissingEnv: "MissingEnv",
} as const;

export class ActionContextError extends Schema.TaggedError<ActionContextError>()(
  "ActionContextError",
  {
    cause: Schema.optionalKey(Schema.Defect()),
    description: Schema.optionalKey(Schema.String),
    reason: Schema.Literals(Object.values(ActionContextErrorReason)),
  },
) {
  readonly code = "ACTION_CONTEXT";

  override get message() {
    return this.description ?? `Context error: ${this.reason}`;
  }
}
