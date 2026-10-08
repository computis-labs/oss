import { Effect, Option, Schema } from "effect";
import { encode } from "fast-png";
import { definePDFJSModule, getDocumentProxy, getResolvedPDFJS, renderPageAsImage } from "unpdf";
import { attempt } from "./support.ts";
import type { BenchmarkError } from "./support.ts";

const PDFJS_ERRORS_ONLY = 0;
const SHARED_OBJECT_PREFIX = "g_";

const decodeImageArgs = Schema.decodeUnknownOption(
  Schema.Tuple([Schema.String, Schema.Finite, Schema.Finite]),
);
const PdfJsImage = Schema.Struct({
  data: Schema.Union([Schema.instanceOf(Uint8Array), Schema.instanceOf(Uint8ClampedArray)]),
  height: Schema.Finite,
  kind: Schema.Finite,
  width: Schema.Finite,
});
const decodeImage = Schema.decodeUnknownOption(PdfJsImage);
const decodeTextItem = Schema.decodeUnknownOption(Schema.Struct({ str: Schema.String }));

const pageNumbers = (count: number) => Array.from({ length: count }, (_, index) => index + 1);

const operatorsOf = (document: Awaited<ReturnType<typeof getDocumentProxy>>, pageNumber: number) =>
  attempt(async () => {
    const page = await document.getPage(pageNumber);
    const operators = await page.getOperatorList();
    return { operators, page };
  });

export const makeBaseline = Effect.gen(function* makePdfJsBaseline() {
  yield* attempt(async () => {
    await definePDFJSModule(async () => await import("pdfjs-dist/legacy/build/pdf.mjs"));
  });
  const { ImageKind, OPS } = yield* attempt(async () => await getResolvedPDFJS());
  const wasmUrl = new URL("../../wasm/", import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs"))
    .href;
  const channelsOf = new Map([
    [ImageKind.GRAYSCALE_1BPP, { channels: 1, depth: 1 }],
    [ImageKind.RGB_24BPP, { channels: 3, depth: 8 }],
    [ImageKind.RGBA_32BPP, { channels: 4, depth: 8 }],
  ] as const);

  const withDocument = <A>(
    bytes: Uint8Array,
    read: (
      document: Awaited<ReturnType<typeof getDocumentProxy>>,
    ) => Effect.Effect<A, BenchmarkError>,
  ) =>
    Effect.acquireUseRelease(
      attempt(
        async () =>
          await getDocumentProxy(new Uint8Array(bytes), { verbosity: PDFJS_ERRORS_ONLY, wasmUrl }),
      ),
      read,
      (document) =>
        Effect.ignore(
          attempt(async () => {
            await document.loadingTask.destroy();
          }),
        ),
    );

  const classify = (bytes: Uint8Array) =>
    withDocument(bytes, (document) =>
      Effect.all(
        pageNumbers(document.numPages).map((pageNumber) =>
          Effect.map(operatorsOf(document, pageNumber), ({ operators }) =>
            new Set(operators.fnArray).has(OPS.paintImageXObject),
          ),
        ),
      ),
    );

  const text = (bytes: Uint8Array) =>
    withDocument(bytes, (document) =>
      Effect.all(
        pageNumbers(document.numPages).map((pageNumber) =>
          attempt(async () => {
            const page = await document.getPage(pageNumber);
            const content = await page.getTextContent();
            return content.items
              .flatMap((item) => Option.toArray(decodeTextItem(item)))
              .map(({ str }) => str)
              .join(" ");
          }),
        ),
        { concurrency: 4 },
      ),
    );

  const images = (bytes: Uint8Array) =>
    withDocument(bytes, (document) =>
      Effect.all(
        pageNumbers(document.numPages).map((pageNumber) =>
          Effect.gen(function* pageImage() {
            const { operators, page } = yield* operatorsOf(document, pageNumber);
            const key = Option.match(
              decodeImageArgs(
                operators.argsArray[operators.fnArray.indexOf(OPS.paintImageXObject)],
              ),
              { onNone: () => "", onSome: ([name]) => name },
            );
            const objects = key.startsWith(SHARED_OBJECT_PREFIX) ? page.commonObjs : page.objs;
            const object = yield* Effect.callback<unknown>((resume) => {
              objects.get(key, (value: typeof PdfJsImage.Encoded) => {
                resume(Effect.succeed(value));
              });
            });
            return Option.flatMap(decodeImage(object), (image) =>
              Option.map(Option.fromNullishOr(channelsOf.get(image.kind)), (layout) =>
                encode({
                  ...layout,
                  data: new Uint8Array(
                    image.data.buffer,
                    image.data.byteOffset,
                    image.data.byteLength,
                  ),
                  height: image.height,
                  width: image.width,
                }),
              ),
            );
          }),
        ),
      ),
    );

  return {
    importScan: (bytes: Uint8Array) => Effect.andThen(classify(bytes), () => images(bytes)),
    importText: (bytes: Uint8Array) => Effect.andThen(classify(bytes), () => text(bytes)),
    render: (bytes: Uint8Array, width: number) =>
      withDocument(bytes, (document) =>
        attempt(
          async () =>
            await renderPageAsImage(document, 1, {
              canvasImport: async () => await import("@napi-rs/canvas"),
              width,
            }),
        ),
      ),
  };
});
