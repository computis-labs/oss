import { Schema } from "effect";

export class EvalConfigError extends Schema.TaggedError<
  EvalConfigError,
  { readonly brand: unique symbol }
>()("EvalConfigError", {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
  path: Schema.String,
}) {
  readonly code = "EVAL_CONFIG";
}
