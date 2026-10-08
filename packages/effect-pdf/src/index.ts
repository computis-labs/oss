import { Effect, Schema } from "effect";
import { PdfEngine } from "./engine.ts";
import { PdfFormError } from "./errors/pdf-form-error.ts";
import { pdfFieldTypes } from "./types.ts";
import type { PdfDocument, PdfFieldValue } from "./types.ts";

const valuelessFieldTypes: ReadonlySet<string> = new Set([
  pdfFieldTypes.button,
  pdfFieldTypes.signature,
]);

export const open = Effect.fn("EffectPdf.open")(function* openPdf(
  bytes: Uint8Array,
  options: { readonly password?: string } = {},
) {
  const engine = yield* PdfEngine;
  return yield* engine.open(bytes, options);
});

export const form = <S extends Schema.Codec<unknown, Readonly<Record<string, PdfFieldValue>>>>(
  schema: S,
) => {
  const decode = Schema.decodeUnknownEffect(schema);
  const encode = Schema.encodeUnknownEffect(schema);
  return {
    read: Effect.fn("EffectPdf.form.read")(function* readForm(document: PdfDocument) {
      const fields = yield* document.fields;
      const values = Object.fromEntries(
        fields.flatMap(({ name, type, value }) =>
          value === undefined || valuelessFieldTypes.has(type) ? [] : [[name, value]],
        ),
      );
      return yield* decode(values).pipe(
        Effect.mapError(
          (cause) =>
            new PdfFormError({
              cause,
              message: `The form does not match the schema: ${cause.message}`,
            }),
        ),
      );
    }),
    write: Effect.fn("EffectPdf.form.write")(function* writeForm(
      document: PdfDocument,
      value: S["Type"],
    ) {
      const values = yield* encode(value).pipe(
        Effect.mapError(
          (cause) =>
            new PdfFormError({
              cause,
              message: `The value does not match the schema: ${cause.message}`,
            }),
        ),
      );
      return yield* document.setFields(values);
    }),
  };
};
