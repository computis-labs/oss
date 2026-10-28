import { Schema } from "effect";

export class EvalReporterError extends Schema.TaggedError<
  EvalReporterError,
  { readonly brand: unique symbol }
>()("EvalReporterError", {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
  reporter: Schema.String,
}) {
  readonly code = "EVAL_REPORTER";
}
