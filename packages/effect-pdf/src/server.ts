import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import { classifyPage } from "./classify.ts";
import { PdfEngineError } from "./errors/pdf-engine-error.ts";
import { PdfFormError } from "./errors/pdf-form-error.ts";
import { PdfOpenError } from "./errors/pdf-open-error.ts";
import { PdfPageError } from "./errors/pdf-page-error.ts";
import { readFields } from "./form.ts";
import { createSignatureField, setFieldValues } from "./form-write.ts";
import type { PdfHandle } from "./handle.ts";
import { readFloats } from "./memory.ts";
import { pageImage } from "./page-images.ts";
import { PdfiumRuntime } from "./pdfium.ts";
import { renderPage } from "./render.ts";
import { PdfRpcs } from "./rpc.ts";
import { saveDocument } from "./save.ts";
import { pageMatches, pageText } from "./text.ts";
import type { PdfPage } from "./types.ts";

interface OpenDocument {
  readonly handle: PdfHandle;
  readonly pointer: number;
  readonly signatureFields: ReadonlySet<number>;
}

const QUARTER_TURN_DEGREES = 90;

export const PdfRpcHandlers = PdfRpcs.toLayer(
  Effect.gen(function* makePdfRpcHandlers() {
    const runtime = yield* PdfiumRuntime;
    const documents = yield* Ref.make<ReadonlyMap<number, OpenDocument>>(new Map());

    const onDocument = Effect.fn("PdfRpcHandlers.onDocument")(function* runOnDocument<A, E>(
      document: number,
      task: (open: OpenDocument) => Result.Result<A, E>,
    ) {
      const open = Option.fromNullishOr((yield* Ref.get(documents)).get(document));
      if (Option.isNone(open)) {
        return yield* new PdfEngineError({ message: "The document is already closed." });
      }
      return yield* runtime.run(open.value.handle.lib, () => task(open.value));
    });

    const eachPage = <A, E>(
      document: number,
      pages: readonly number[],
      read: (handle: PdfHandle, page: number) => Result.Result<A, E>,
    ) => onDocument(document, ({ handle }) => Result.all(pages.map((page) => read(handle, page))));

    return {
      AddSignatureField: ({ document, field }) =>
        Effect.gen(function* addSignatureField() {
          const objectNumber = yield* onDocument(document, ({ handle, signatureFields }) =>
            readFields(handle, signatureFields).pipe(
              Result.flatMap((fields) =>
                fields.some(({ name }) => name === field.name)
                  ? Result.fail(
                      new PdfFormError({
                        field: field.name,
                        message: `The document already has a field named "${field.name}".`,
                      }),
                    )
                  : createSignatureField(handle, field),
              ),
            ),
          );
          return yield* Ref.update(documents, (open) => {
            const entry = open.get(document);
            return entry === undefined
              ? open
              : new Map(open).set(document, {
                  ...entry,
                  signatureFields: new Set([...entry.signatureFields, objectNumber]),
                });
          });
        }),
      Classify: ({ document, pages }) => eachPage(document, pages, classifyPage),
      Close: ({ document }) =>
        Effect.gen(function* closeDocument() {
          const entry = yield* Ref.modify(
            documents,
            (open): [OpenDocument | undefined, ReadonlyMap<number, OpenDocument>] => {
              const rest = new Map(open);
              rest.delete(document);
              return [open.get(document), rest];
            },
          );
          if (entry === undefined) {
            return;
          }
          yield* runtime
            .run(entry.handle.lib, (lib) => {
              lib.FPDF_CloseDocument(entry.handle.document);
              lib.pdfium._free(entry.pointer);
              return Result.void;
            })
            .pipe(Effect.ignore);
        }),
      Fields: ({ document }) =>
        onDocument(document, ({ handle, signatureFields }) => readFields(handle, signatureFields)),
      Find: ({ document, flags, pages, source }) =>
        eachPage(document, pages, (handle, page) =>
          pageMatches(handle, page, new RegExp(source, flags)),
        ).pipe(Effect.map((matches) => matches.flat())),
      Open: ({ bytes, document, password }) =>
        Effect.gen(function* openDocument() {
          const lib = yield* runtime.current;
          const opened = yield* runtime.run(
            lib,
            (
              pdfium,
            ): Result.Result<
              {
                readonly handle: number;
                readonly pages: readonly PdfPage[];
                readonly pointer: number;
              },
              PdfOpenError | PdfPageError
            > => {
              const pointer = pdfium.pdfium._malloc(Math.max(bytes.length, 1));
              pdfium.pdfium.HEAPU8.set(bytes, pointer);
              const handle = pdfium.FPDF_LoadMemDocument(pointer, bytes.length, password);
              if (handle === 0) {
                const error = PdfOpenError.fromPdfiumError(pdfium.FPDF_GetLastError());
                pdfium.pdfium._free(pointer);
                return Result.fail(error);
              }
              const pages = Result.all(
                Array.from({ length: pdfium.FPDF_GetPageCount(handle) }, (_, index) => {
                  const size = readFloats(pdfium, 2, (target) =>
                    pdfium.FPDF_GetPageSizeByIndexF(handle, index, target),
                  );
                  const quarterTurns = pdfium.EPDF_GetPageRotationByIndex(handle, index);
                  const [shownWidth = 0, shownHeight = 0] = size ?? [];
                  const sideways = quarterTurns % 2 === 1;
                  return size === null
                    ? Result.fail(PdfPageError.unreadable(index))
                    : Result.succeed({
                        height: sideways ? shownWidth : shownHeight,
                        index,
                        rotation: quarterTurns * QUARTER_TURN_DEGREES,
                        width: sideways ? shownHeight : shownWidth,
                      });
                }),
              );
              if (Result.isFailure(pages)) {
                pdfium.FPDF_CloseDocument(handle);
                pdfium.pdfium._free(pointer);
                return Result.fail(pages.failure);
              }
              return Result.succeed({ handle, pages: pages.success, pointer });
            },
          );
          yield* Ref.update(documents, (open) =>
            new Map(open).set(document, {
              handle: { document: opened.handle, lib, pageCount: opened.pages.length },
              pointer: opened.pointer,
              signatureFields: new Set<number>(),
            }),
          );
          return opened.pages;
        }),
      PageImages: ({ document, dpi, pages }) =>
        eachPage(document, pages, (handle, page) => pageImage(handle, page, dpi)),
      Render: ({ document, page, size }) =>
        onDocument(document, ({ handle }) => renderPage(handle, page, size)),
      Save: ({ document, incremental }) =>
        onDocument(document, ({ handle, signatureFields }) =>
          saveDocument(handle, incremental, signatureFields),
        ),
      SetFields: ({ document, values }) =>
        onDocument(document, ({ handle, signatureFields }) =>
          setFieldValues(handle, signatureFields, values),
        ),
      Text: ({ document, layout, pages }) =>
        eachPage(document, pages, (handle, page) => pageText(handle, page, layout)),
    };
  }),
);
