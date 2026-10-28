import { Schema } from "effect";

export class ActionFailed extends Schema.TaggedError<ActionFailed>()("ActionFailed", {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {
  readonly code = "ACTION_FAILED";

  get displayMessage() {
    return this.message;
  }
}
