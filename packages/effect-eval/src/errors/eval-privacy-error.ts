import { Schema } from "effect";

export class EvalPrivacyError extends Schema.TaggedError<
  EvalPrivacyError,
  { readonly brand: unique symbol }
>()("EvalPrivacyError", {
  findings: Schema.Array(
    Schema.Struct({ case: Schema.String, path: Schema.String, rule: Schema.String }),
  ),
}) {
  readonly code = "EVAL_PRIVACY";

  override get message() {
    return this.findings
      .map((finding) => `${finding.case} ${finding.path}: ${finding.rule}`)
      .join("\n");
  }
}
