import { NodeServices } from "@effect/platform-node";
import { Worker } from "node:worker_threads";
import { describe, expect, it, layer } from "@effect/vitest";
import { vi } from "vitest";
import { Effect, FileSystem, Layer, Path, Result } from "effect";
import { LONG_FORM_LAST_PAGE, fixture, formPdf, longFormPdf, textPdf } from "./fixtures/forms.ts";
import { nodeWorkers } from "./fixtures/layer.ts";
import { PdfEngine, pdfWorkerEntry } from "../src/engine.ts";
import { PdfEngineError } from "../src/errors/pdf-engine-error.ts";
import { open } from "../src/index.ts";
import { scanPdf } from "../src/testing.ts";
import { PdfiumRuntime } from "../src/pdfium.ts";
import { PdfiumWasm } from "../src/pdfium-wasm.ts";
import { pdfImageMediaTypes, pdfPageKinds } from "../src/types.ts";

const OUT_OF_BOUNDS_POINTER = 0x7f_ff_ff_f0;
const LONG_DOCUMENT_PAGES = 12;

const pdfiumOnlyFileSystem = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const wasm = yield* path.fromFileUrl(
      new URL(import.meta.resolve("@embedpdf/pdfium/pdfium.wasm")),
    );
    const bytes = yield* fs.readFile(wasm);
    const noop = FileSystem.makeNoop({});
    return FileSystem.layerNoop({
      readFile: (file) => (file === wasm ? Effect.succeed(bytes) : noop.readFile(file)),
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

const spawned: Worker[] = [];
const recordedWorkers = PdfEngine.layer({ size: 2 }).pipe(
  Layer.provide(
    nodeWorkers(() => {
      const worker = new Worker(pdfWorkerEntry);
      spawned.push(worker);
      return worker;
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const longDocument = textPdf(
  Array.from({ length: LONG_DOCUMENT_PAGES }, (_, page) => [`Pagina numero ${page.toString()}`]),
);

layer(
  PdfiumRuntime.layer.pipe(
    Layer.provide(PdfiumWasm.layerCompiled),
    Layer.provide(NodeServices.layer),
  ),
)("PDFium runtime", (it) => {
  it.effect("turns a PDFium crash into a typed error and starts a fresh PDFium", () =>
    Effect.gen(function* () {
      const runtime = yield* PdfiumRuntime;
      const crashed = yield* runtime.current;

      const crash = yield* Effect.flip(
        runtime.run(crashed, (pdfium) =>
          Result.succeed(pdfium.FPDF_GetPageCount(OUT_OF_BOUNDS_POINTER)),
        ),
      );
      const stale = yield* Effect.flip(runtime.run(crashed, () => Result.void));

      expect(crash).toBeInstanceOf(PdfEngineError);
      expect(stale.message).toContain("open the document again");
      expect(yield* runtime.current).not.toBe(crashed);
    }),
  );
});

layer(recordedWorkers)("worker pool", (it) => {
  it.effect("replaces a worker that died and fails only the documents it held", () =>
    Effect.gen(function* () {
      const before = yield* open(scanPdf());
      const startedWith = spawned.length;

      yield* fixture(
        async () => await Promise.all(spawned.map(async (worker) => await worker.terminate())),
      );
      const lost = yield* Effect.flip(before.classify);
      const after = yield* open(scanPdf());

      expect(lost).toBeInstanceOf(PdfEngineError);
      expect((yield* after.classify).kind).toBe(pdfPageKinds.image);
      expect(spawned.length).toBeGreaterThan(startedWith);
    }),
  );

  it.effect("reads a long document across workers in page order", () =>
    Effect.gen(function* () {
      const document = yield* open(yield* longDocument);

      const pages = yield* document.text();
      const scattered = yield* document.text({ pages: [11, 3, 7, 0, 5, 9, 1, 10] });

      expect(pages.map(({ page }) => page)).toStrictEqual(
        Array.from({ length: LONG_DOCUMENT_PAGES }, (_, page) => page),
      );
      expect(
        pages.every(({ page, text }) => text.includes(`Pagina numero ${page.toString()}`)),
      ).toBe(true);
      expect(scattered.map(({ page }) => page)).toStrictEqual([11, 3, 7, 0, 5, 9, 1, 10]);
    }),
  );

  it.effect("renders an edited long document from the edited copy, not from a stale replica", () =>
    Effect.gen(function* () {
      const document = yield* open(yield* longFormPdf);
      yield* document.text();
      const before = yield* document.render(LONG_FORM_LAST_PAGE, { dpi: 72 });

      yield* document.setFields({ ragioneSociale: "Studio di Prova & Partner" });
      yield* document.text();
      const after = yield* document.render(LONG_FORM_LAST_PAGE, { dpi: 72 });
      const reopened = yield* open(yield* document.save());
      const expected = yield* reopened.render(LONG_FORM_LAST_PAGE, { dpi: 72 });

      expect(after.bytes).not.toStrictEqual(before.bytes);
      expect(after.bytes).toStrictEqual(expected.bytes);
    }),
  );

  it.effect("keeps reading the edited document after a change", () =>
    Effect.gen(function* () {
      const document = yield* open(yield* formPdf);

      yield* document.setFields({ ragioneSociale: "Studio di Prova & Partner" });
      const fields = yield* document.fields;

      expect(fields.find(({ name }) => name === "ragioneSociale")?.value).toBe(
        "Studio di Prova & Partner",
      );
    }),
  );
});

describe("in-process engine", () => {
  layer(PdfEngine.layerInProcess.pipe(Layer.provideMerge(NodeServices.layer)))((it) => {
    it.effect("gives the same results as the worker pool", () =>
      Effect.gen(function* () {
        const document = yield* open(yield* longDocument);

        const [classification, pages] = yield* Effect.all([document.classify, document.text()]);

        expect(classification.kind).toBe(pdfPageKinds.text);
        expect(pages).toHaveLength(LONG_DOCUMENT_PAGES);
      }),
    );
  });
});

describe("engine without a platform", () => {
  layer(
    PdfEngine.layerInProcess.pipe(Layer.provide(Layer.merge(pdfiumOnlyFileSystem, Path.layer))),
  )((it) => {
    it.effect("reads and renders a PDF with only a FileSystem that serves PDFium", () =>
      Effect.gen(function* () {
        const document = yield* open(yield* longDocument);

        const [text] = yield* document.text({ pages: [0] });
        const image = yield* document.render(0, { dpi: 72 });

        expect(text?.text).toContain("Pagina numero 0");
        expect(image.mediaType).toBe(pdfImageMediaTypes.png);
        expect(image.bytes.subarray(1, 4)).toStrictEqual(new TextEncoder().encode("PNG"));
      }),
    );
  });
});

describe("default pool size", () => {
  it.effect.each([
    ["no navigator", undefined, 1],
    ["a navigator without hardwareConcurrency", {}, 1],
    ["a navigator that reports 3 CPUs", { hardwareConcurrency: 3 }, 2],
  ] as const)("uses the CPUs reported by %s", ([, navigator, expected]) =>
    Effect.gen(function* () {
      vi.stubGlobal("navigator", navigator);
      const engine = PdfEngine.layer().pipe(
        Layer.provide(nodeWorkers()),
        Layer.provide(NodeServices.layer),
      );
      vi.unstubAllGlobals();

      const { size } = yield* Effect.provide(PdfEngine, engine);

      expect(size).toBe(expected);
    }),
  );
});
