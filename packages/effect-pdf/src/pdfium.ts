import { init } from "@embedpdf/pdfium";
import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type * as Result from "effect/Result";
import { PdfEngineError } from "#effect-pdf/errors/pdf-engine-error";
import { PdfiumWasm } from "#effect-pdf/pdfium-wasm";

export type Pdfium = WrappedPdfiumModule;

const boot = Effect.fn("PdfiumRuntime.boot")(function* bootPdfium(module: WebAssembly.Module) {
  return yield* Effect.tryPromise({
    catch: (cause) => new PdfEngineError({ cause, message: "PDFium could not start." }),
    try: async () => {
      const lib = await init({
        instantiateWasm: (imports, receive) => {
          const instance = new WebAssembly.Instance(module, imports);
          receive(instance);
          return instance.exports;
        },
      });
      lib.PDFiumExt_Init();
      return lib;
    },
  });
});

export class PdfiumRuntime extends Context.Service<PdfiumRuntime>()(
  "@computis/effect-pdf/pdfium/PdfiumRuntime",
  {
    make: Effect.gen(function* makePdfiumRuntime() {
      const { module } = yield* PdfiumWasm;
      const current = yield* SynchronizedRef.make(yield* boot(module));

      return {
        current: SynchronizedRef.get(current),
        run: Effect.fn("PdfiumRuntime.run")(function* runOnPdfium<A, E>(
          lib: Pdfium,
          task: (lib: Pdfium) => Result.Result<A, E>,
        ) {
          if ((yield* SynchronizedRef.get(current)) !== lib) {
            return yield* new PdfEngineError({
              message: "PDFium restarted after a failure: open the document again.",
            });
          }
          const outcome = yield* Effect.try({
            catch: (cause) =>
              new PdfEngineError({ cause, message: "PDFium failed on this document." }),
            try: () => task(lib),
          }).pipe(Effect.tapError(() => SynchronizedRef.updateEffect(current, () => boot(module))));
          return yield* Effect.fromResult(outcome);
        }),
      } as const;
    }),
  },
) {
  static readonly layer = Layer.effect(PdfiumRuntime, PdfiumRuntime.make);
}
