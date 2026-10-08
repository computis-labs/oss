import * as Schema from "effect/Schema";

export class PdfPageError extends Schema.TaggedError<PdfPageError>()("PdfPageError", {
  message: Schema.String,
  page: Schema.Number,
}) {
  readonly code = "PDF_PAGE";

  static outOfRange(page: number, pageCount: number) {
    return new PdfPageError({
      message: `Page ${page.toString()} does not exist: the document has ${pageCount.toString()} pages, numbered from 0.`,
      page,
    });
  }

  static unreadable(page: number) {
    return new PdfPageError({ message: `PDFium could not load page ${page.toString()}.`, page });
  }

  static unreadableImage(page: number) {
    return new PdfPageError({
      message: `PDFium could not read the size and colour space of an image on page ${page.toString()}.`,
      page,
    });
  }

  static unmeasurable(page: number) {
    return new PdfPageError({
      message: `PDFium could not read the position of an object on page ${page.toString()}.`,
      page,
    });
  }
}
