import { NodeServices } from "@effect/platform-node";
import { Layer } from "effect";
import { PdfEngine } from "#effect-pdf/engine";

export const pdfEngineLayer = Layer.merge(PdfEngine.layer({ size: 2 }), NodeServices.layer);
