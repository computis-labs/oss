import { Schema } from "effect";

export const ActionOIDCErrorReason = {
  NotAvailable: "NotAvailable",
  RequestFailed: "RequestFailed",
} as const;

export class ActionOIDCError extends Schema.TaggedError<ActionOIDCError>()("ActionOIDCError", {
  cause: Schema.optionalKey(Schema.Defect()),
  description: Schema.optionalKey(Schema.String),
  reason: Schema.Literals(Object.values(ActionOIDCErrorReason)),
}) {
  override get message() {
    if (this.reason === ActionOIDCErrorReason.NotAvailable) {
      return "OIDC token is not available in this environment";
    }

    return `OIDC token request failed${this.description === undefined ? "" : `: ${this.description}`}`;
  }
}
