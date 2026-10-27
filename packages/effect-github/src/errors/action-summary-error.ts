import { Schema } from "effect";

export const ActionSummaryErrorReason = {
  NotAvailable: "NotAvailable",
  WriteFailed: "WriteFailed",
} as const;

export class ActionSummaryError extends Schema.TaggedError<ActionSummaryError>()(
  "ActionSummaryError",
  {
    cause: Schema.optionalKey(Schema.Defect()),
    description: Schema.optionalKey(Schema.String),
    reason: Schema.Literals(Object.values(ActionSummaryErrorReason)),
  },
) {
  override get message() {
    if (this.reason === ActionSummaryErrorReason.NotAvailable) {
      return "Job summary is not available in this environment";
    }

    return `Failed to write job summary${this.description === undefined ? "" : `: ${this.description}`}`;
  }
}
