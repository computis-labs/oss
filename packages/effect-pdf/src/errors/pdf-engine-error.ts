import * as Schema from "effect/Schema";

export class PdfEngineError extends Schema.TaggedError<PdfEngineError>()("PdfEngineError", {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {
  readonly code = "PDF_ENGINE";
}
