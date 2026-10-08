import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Transferable from "effect/workers/Transferable";
import { PdfEngineError } from "./errors/pdf-engine-error.ts";
import type { WasmModule } from "./types/webassembly.d.ts";

export const PdfWorkerInit = Schema.Struct({
  wasm: Transferable.schema(Schema.instanceOf(WebAssembly.Module), () => []),
});

const missingBinary = (cause: unknown) =>
  new PdfEngineError({ cause, message: "The PDFium binary is missing or cannot be compiled." });

export class PdfiumWasm extends Context.Service<PdfiumWasm, { readonly module: WasmModule }>()(
  "@computis/effect-pdf/pdfium-wasm/PdfiumWasm",
) {
  static readonly layerCompiled = Layer.effect(
    PdfiumWasm,
    Effect.gen(function* compilePdfium() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const wasmPath = yield* path
        .fromFileUrl(new URL(import.meta.resolve("@embedpdf/pdfium/pdfium.wasm")))
        .pipe(Effect.mapError(missingBinary));
      const bytes = yield* fs.readFile(wasmPath).pipe(Effect.mapError(missingBinary));
      const module = yield* Effect.tryPromise({
        catch: missingBinary,
        try: async () => await WebAssembly.compile(new Uint8Array(bytes)),
      });
      return { module };
    }),
  );
}
