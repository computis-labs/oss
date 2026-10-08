import * as Schema from "effect/Schema";
import type * as Effect from "effect/Effect";
import * as Transferable from "effect/workers/Transferable";
import type { PdfEngineError } from "#effect-pdf/errors/pdf-engine-error";
import type { PdfFormError } from "#effect-pdf/errors/pdf-form-error";
import type { PdfPageError } from "#effect-pdf/errors/pdf-page-error";
import type { PdfSaveError } from "#effect-pdf/errors/pdf-save-error";

export const pdfPageKinds = {
  empty: "empty",
  image: "image",
  mixed: "mixed",
  text: "text",
} as const;
export type PdfPageKind = (typeof pdfPageKinds)[keyof typeof pdfPageKinds];

export const pdfImageOrigins = { embedded: "embedded", rendered: "rendered" } as const;

export const pdfImageMediaTypes = { jpeg: "image/jpeg", png: "image/png" } as const;

export const pdfFieldTypes = {
  button: "button",
  checkbox: "checkbox",
  combobox: "combobox",
  listbox: "listbox",
  radio: "radio",
  signature: "signature",
  text: "text",
  unknown: "unknown",
} as const;
export type PdfFieldType = (typeof pdfFieldTypes)[keyof typeof pdfFieldTypes];

export const PdfRectSchema = Schema.Struct({
  bottom: Schema.Finite,
  left: Schema.Finite,
  right: Schema.Finite,
  top: Schema.Finite,
});
export type PdfRect = typeof PdfRectSchema.Type;

export const PdfPageSchema = Schema.Struct({
  height: Schema.Finite,
  index: Schema.Int,
  rotation: Schema.Int,
  width: Schema.Finite,
});
export type PdfPage = typeof PdfPageSchema.Type;

const PdfPageKindSchema = Schema.Literals(Object.values(pdfPageKinds));

export const PdfPageClassificationSchema = Schema.Struct({
  hiddenText: Schema.Boolean,
  imageCoverage: Schema.Finite,
  kind: PdfPageKindSchema,
  visibleText: Schema.Boolean,
});
export type PdfPageClassification = typeof PdfPageClassificationSchema.Type;

export interface PdfClassification {
  readonly kind: PdfPageKind;
  readonly pages: readonly PdfPageClassification[];
}

export const PdfPageTextSchema = Schema.Struct({
  page: Schema.Int,
  text: Schema.String,
  unicodeMapErrors: Schema.Int,
});
export type PdfPageText = typeof PdfPageTextSchema.Type;

export const PdfPointSchema = Schema.Struct({ x: Schema.Finite, y: Schema.Finite });

export const PdfTextMatchSchema = Schema.Struct({
  box: PdfRectSchema,
  groups: Schema.Record(Schema.String, Schema.String),
  origin: PdfPointSchema,
  page: Schema.Int,
  text: Schema.String,
});
export type PdfTextMatch = typeof PdfTextMatchSchema.Type;

export const PdfImageSchema = Schema.Struct({
  bytes: Transferable.Uint8Array,
  height: Schema.Int,
  mediaType: Schema.Literals(Object.values(pdfImageMediaTypes)),
  origin: Schema.Literals(Object.values(pdfImageOrigins)),
  width: Schema.Int,
});
export type PdfImage = typeof PdfImageSchema.Type;

export const PdfFieldValueSchema = Schema.Union([Schema.String, Schema.Boolean]);
export type PdfFieldValue = typeof PdfFieldValueSchema.Type;

export const PdfFieldValuesSchema = Schema.Record(Schema.String, PdfFieldValueSchema);

export const PdfFieldSchema = Schema.Struct({
  name: Schema.String,
  type: Schema.Literals(Object.values(pdfFieldTypes)),
  value: Schema.UndefinedOr(PdfFieldValueSchema),
  widgets: Schema.Array(Schema.Struct({ page: Schema.Int, rect: PdfRectSchema })),
});
export type PdfField = typeof PdfFieldSchema.Type;

export const PdfSignatureFieldSchema = Schema.Struct({
  name: Schema.String,
  page: Schema.Int,
  rect: PdfRectSchema,
});
export type PdfSignatureField = typeof PdfSignatureFieldSchema.Type;

export interface PageSelection {
  readonly pages?: readonly number[];
}

export interface TextOptions extends PageSelection {
  readonly layout?: boolean;
}

export const PdfRenderSizeSchema = Schema.Struct({
  dpi: Schema.optionalKey(Schema.Finite),
  width: Schema.optionalKey(Schema.Int),
});
export type PdfRenderSize = typeof PdfRenderSizeSchema.Type;

export interface PdfDocument {
  readonly addSignatureField: (
    field: PdfSignatureField,
  ) => Effect.Effect<void, PdfEngineError | PdfFormError | PdfPageError>;
  readonly classify: Effect.Effect<PdfClassification, PdfEngineError | PdfPageError>;
  readonly fields: Effect.Effect<readonly PdfField[], PdfEngineError | PdfFormError | PdfPageError>;
  readonly find: (
    pattern: RegExp,
    selection?: PageSelection,
  ) => Effect.Effect<readonly PdfTextMatch[], PdfEngineError | PdfPageError>;
  readonly pageCount: number;
  readonly pageImages: (
    options?: PageSelection & Pick<PdfRenderSize, "dpi">,
  ) => Effect.Effect<readonly PdfImage[], PdfEngineError | PdfPageError>;
  readonly pages: readonly PdfPage[];
  readonly render: (
    page: number,
    size?: PdfRenderSize,
  ) => Effect.Effect<PdfImage, PdfEngineError | PdfPageError>;
  readonly save: (options?: {
    readonly incremental?: boolean;
  }) => Effect.Effect<Uint8Array, PdfEngineError | PdfSaveError>;
  readonly setFields: (
    values: Readonly<Record<string, PdfFieldValue>>,
  ) => Effect.Effect<void, PdfEngineError | PdfFormError | PdfPageError>;
  readonly text: (
    options?: TextOptions,
  ) => Effect.Effect<readonly PdfPageText[], PdfEngineError | PdfPageError>;
}
