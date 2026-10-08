import * as Result from "effect/Result";
import { PdfSaveError } from "./errors/pdf-save-error.ts";
import type { PdfHandle } from "./handle.ts";

const INCREMENTAL = 1;
const NO_INCREMENTAL = 2;
const TEXT_FIELD_HEAD = "/FT/Tx/Kids[ ";
const SIGNATURE_FIELD_HEAD = "/FT/Sig/Kids[";

const ascii = new TextEncoder();

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
    try {
      lib.PDFiumExt_GetFileWriterData(writer, pointer, size);
      saved.set(lib.pdfium.HEAPU8.subarray(pointer, pointer + size));
    } finally {
      lib.pdfium._free(pointer);
    }
    const heads = [...signatureFields].map((objectNumber) => {
      const prefix = `${objectNumber.toString()} 0 obj\r\n<<`;
      const pattern = ascii.encode(`${prefix}${TEXT_FIELD_HEAD}`);
      for (let at = saved.length - pattern.length; at >= 0; at -= 1) {
        if (
          saved[at] === pattern[0] &&
          pattern.every((byte, offset) => saved[at + offset] === byte)
        ) {
          return { at: at + prefix.length, objectNumber };
        }
      }
      return { at: -1, objectNumber };
    });
    const missing = heads.find(({ at }) => at === -1);
    if (missing !== undefined) {
      return Result.fail(
        new PdfSaveError({
          message: `The signature field in object ${missing.objectNumber.toString()} was not written as PDFium writes it, so it could not be marked as a signature field.`,
        }),
      );
    }
    for (const { at } of heads) {
      saved.set(ascii.encode(SIGNATURE_FIELD_HEAD), at);
    }
    return Result.succeed(saved);
  } finally {
    lib.PDFiumExt_CloseFileWriter(writer);
  }
};
