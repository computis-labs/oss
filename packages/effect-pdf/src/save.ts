import * as Result from "effect/Result";
import { PdfSaveError } from "./errors/pdf-save-error.ts";
import type { PdfHandle } from "./handle.ts";

const INCREMENTAL = 1;
const NO_INCREMENTAL = 2;
const TEXT_FIELD_HEAD = "/FT/Tx/Kids[ ";
const SIGNATURE_FIELD_HEAD = "/FT/Sig/Kids[";

export const saveDocument = (
  { document, lib }: PdfHandle,
  incremental: boolean,
  signatureFields: ReadonlySet<number>,
): Result.Result<Uint8Array<ArrayBuffer>, PdfSaveError> => {
  const writer = lib.PDFiumExt_OpenFileWriter();
  try {
    if (!lib.FPDF_SaveAsCopy(document, writer, incremental ? INCREMENTAL : NO_INCREMENTAL)) {
      return Result.fail(new PdfSaveError({ message: "PDFium could not write the document." }));
    }
    const size = lib.PDFiumExt_GetFileWriterSize(writer);
    const pointer = lib.pdfium._malloc(size);
    const saved = new Uint8Array(size);
    const bytes = Buffer.from(saved.buffer);
    try {
      lib.PDFiumExt_GetFileWriterData(writer, pointer, size);
      bytes.set(lib.pdfium.HEAPU8.subarray(pointer, pointer + size));
    } finally {
      lib.pdfium._free(pointer);
    }
    const heads = [...signatureFields].map((objectNumber) => ({
      at: bytes.lastIndexOf(
        `${objectNumber.toString()} 0 obj\r\n<<${TEXT_FIELD_HEAD}`,
        bytes.length,
        "latin1",
      ),
      objectNumber,
    }));
    const missing = heads.find(({ at }) => at === -1);
    if (missing !== undefined) {
      return Result.fail(
        new PdfSaveError({
          message: `The signature field in object ${missing.objectNumber.toString()} was not written as PDFium writes it, so it could not be marked as a signature field.`,
        }),
      );
    }
    for (const { at } of heads) {
      bytes.write(SIGNATURE_FIELD_HEAD, bytes.indexOf(TEXT_FIELD_HEAD, at, "latin1"), "latin1");
    }
    return Result.succeed(saved);
  } finally {
    lib.PDFiumExt_CloseFileWriter(writer);
  }
};
