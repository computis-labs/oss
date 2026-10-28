import { Schema } from "effect";

export class EvalHistoryError extends Schema.TaggedError<
  EvalHistoryError,
  { readonly brand: unique symbol }
>()("EvalHistoryError", {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {
  readonly code = "EVAL_HISTORY";
}
