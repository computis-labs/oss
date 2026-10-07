import { Schema } from "effect";

export const PromptProjectErrorReason = {
  FormatFailed: "FormatFailed",
  Outdated: "Outdated",
} as const;

export class PromptProjectError extends Schema.TaggedError<PromptProjectError>()(
  "PromptProjectError",
  {
    detail: Schema.String,
    output: Schema.String,
    reason: Schema.Literals(Object.values(PromptProjectErrorReason)),
  },
) {
  override get message() {
    return `${this.output}: ${this.detail}`;
  }
}
