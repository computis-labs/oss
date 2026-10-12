import { Schema } from "effect";

export class ActionApiError extends Schema.TaggedError<ActionApiError>()("ActionApiError", {
  cause: Schema.optionalKey(Schema.Defect()),
  description: Schema.optionalKey(Schema.String),
  method: Schema.String,
  status: Schema.optionalKey(Schema.Number),
}) {
  override get message() {
    const status = this.status === undefined ? "" : ` (${this.status})`;
    const description = this.description === undefined ? "" : ` - ${this.description}`;
    return `GitHub API error${status}: ${this.method}${description}`;
  }

  get isRateLimited() {
    return this.status === 403 || this.status === 429;
  }
}
