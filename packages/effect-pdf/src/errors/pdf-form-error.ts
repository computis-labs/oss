import * as Schema from "effect/Schema";

export class PdfFormError extends Schema.TaggedError<PdfFormError>()("PdfFormError", {
  cause: Schema.optionalKey(Schema.Defect()),
  field: Schema.optionalKey(Schema.String),
  message: Schema.String,
}) {
  readonly code = "PDF_FORM";
}
