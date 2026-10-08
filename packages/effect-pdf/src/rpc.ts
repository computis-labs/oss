import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Transferable from "effect/workers/Transferable";
import { PdfEngineError } from "./errors/pdf-engine-error.ts";
import { PdfFormError } from "./errors/pdf-form-error.ts";
import { PdfOpenError } from "./errors/pdf-open-error.ts";
import { PdfPageError } from "./errors/pdf-page-error.ts";
import { PdfSaveError } from "./errors/pdf-save-error.ts";
import {
  PdfFieldSchema,
  PdfFieldValuesSchema,
  PdfImageSchema,
  PdfPageClassificationSchema,
  PdfPageSchema,
  PdfPageTextSchema,
  PdfRenderSizeSchema,
  PdfSignatureFieldSchema,
  PdfTextMatchSchema,
} from "./types.ts";

const DocumentId = Schema.Int;
const Pages = Schema.Array(Schema.Int);
const PageFailure = Schema.Union([PdfEngineError, PdfPageError]);
const FormFailure = Schema.Union([PdfEngineError, PdfFormError, PdfPageError]);

export class PdfRpcs extends RpcGroup.make(
  Rpc.make("Open", {
    error: Schema.Union([PdfEngineError, PdfOpenError, PdfPageError]),
    payload: { bytes: Transferable.Uint8Array, document: DocumentId, password: Schema.String },
    success: Schema.Array(PdfPageSchema),
  }),
  Rpc.make("Close", { payload: { document: DocumentId } }),
  Rpc.make("Classify", {
    error: PageFailure,
    payload: { document: DocumentId, pages: Pages },
    success: Schema.Array(PdfPageClassificationSchema),
  }),
  Rpc.make("Text", {
    error: PageFailure,
    payload: { document: DocumentId, layout: Schema.Boolean, pages: Pages },
    success: Schema.Array(PdfPageTextSchema),
  }),
  Rpc.make("Find", {
    error: PageFailure,
    payload: { document: DocumentId, flags: Schema.String, pages: Pages, source: Schema.String },
    success: Schema.Array(PdfTextMatchSchema),
  }),
  Rpc.make("PageImages", {
    error: PageFailure,
    payload: { document: DocumentId, dpi: Schema.Finite, pages: Pages },
    success: Schema.Array(PdfImageSchema),
  }),
  Rpc.make("Render", {
    error: PageFailure,
    payload: { document: DocumentId, page: Schema.Int, size: PdfRenderSizeSchema },
    success: PdfImageSchema,
  }),
  Rpc.make("Fields", {
    error: FormFailure,
    payload: { document: DocumentId },
    success: Schema.Array(PdfFieldSchema),
  }),
  Rpc.make("SetFields", {
    error: FormFailure,
    payload: { document: DocumentId, values: PdfFieldValuesSchema },
  }),
  Rpc.make("AddSignatureField", {
    error: FormFailure,
    payload: { document: DocumentId, field: PdfSignatureFieldSchema },
  }),
  Rpc.make("Save", {
    error: Schema.Union([PdfEngineError, PdfSaveError]),
    payload: { document: DocumentId, incremental: Schema.Boolean },
    success: Transferable.Uint8Array,
  }),
) {}
