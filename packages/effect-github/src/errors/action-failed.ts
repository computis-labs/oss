import { Schema } from "effect";

export class ActionFailed extends Schema.TaggedError<ActionFailed>()("ActionFailed", {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {
  get displayMessage() {
    return this.message;
  }
}
