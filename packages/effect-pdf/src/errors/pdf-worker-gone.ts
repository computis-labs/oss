import * as Schema from "effect/Schema";

export class PdfWorkerGone extends Schema.TaggedError<PdfWorkerGone>()("PdfWorkerGone", {
  cause: Schema.Defect(),
}) {
  readonly code = "PDF_WORKER_GONE";
}
