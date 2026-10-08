import * as Schema from "effect/Schema";

export const pdfOpenFailures = {
  file: "file",
  format: "format",
  password: "password",
  security: "security",
  unknown: "unknown",
} as const;

export type PdfOpenFailure = (typeof pdfOpenFailures)[keyof typeof pdfOpenFailures];

const pdfiumLastErrors: ReadonlyMap<number, PdfOpenFailure> = new Map([
  [2, pdfOpenFailures.file],
  [3, pdfOpenFailures.format],
  [4, pdfOpenFailures.password],
  [5, pdfOpenFailures.security],
]);

const messages = {
  file: "The PDF could not be read.",
  format: "The bytes are not a valid PDF.",
  password: "The PDF is protected by a password, and the password is missing or wrong.",
  security: "The PDF uses an encryption PDFium does not support.",
  unknown: "PDFium could not open the PDF.",
} as const satisfies Record<PdfOpenFailure, string>;

export class PdfOpenError extends Schema.TaggedError<PdfOpenError>()("PdfOpenError", {
  message: Schema.String,
  reason: Schema.Literals(Object.values(pdfOpenFailures)),
}) {
  readonly code = "PDF_OPEN";

  static fromPdfiumError(lastError: number) {
    const reason = pdfiumLastErrors.get(lastError) ?? pdfOpenFailures.unknown;
    return new PdfOpenError({ message: messages[reason], reason });
  }
}
