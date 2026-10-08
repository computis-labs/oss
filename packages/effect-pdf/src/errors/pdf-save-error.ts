import * as Schema from "effect/Schema";

export class PdfSaveError extends Schema.TaggedError<PdfSaveError>()("PdfSaveError", {
  message: Schema.String,
}) {
  readonly code = "PDF_SAVE";
}
