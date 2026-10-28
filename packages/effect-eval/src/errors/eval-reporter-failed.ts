import { Schema } from "effect";

export class EvalReporterFailed extends Schema.TaggedError<
  EvalReporterFailed,
  { readonly brand: unique symbol }
>()("EvalReporterFailed", {
  cause: Schema.Defect(),
  reporter: Schema.String,
}) {
  readonly code = "EVAL_REPORTER_FAILED";

  override get message() {
    return `The required reporter ${this.reporter} failed.`;
  }
}
