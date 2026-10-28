import { Schema } from "effect";

export class EvalDatasetError extends Schema.TaggedError<
  EvalDatasetError,
  { readonly brand: unique symbol }
>()("EvalDatasetError", {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
  path: Schema.String,
}) {
  readonly code = "EVAL_DATASET";
}
