import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { PDFSignature } from "pdf-lib";
import { pdfEngineLayer } from "./fixtures/layer.ts";
import { formPdf, loadWithPdfLib, textPdf } from "./fixtures/forms.ts";
import { jpegScanPdf } from "./fixtures/scans.ts";
import { PdfFormError } from "#effect-pdf/errors/pdf-form-error";
import { form, open } from "#effect-pdf/index";
import { pdfFieldTypes } from "#effect-pdf/types";

const Iscrizione = Schema.Struct({
  pagamento: Schema.optionalKey(Schema.Literals(["bonifico", "contanti"])),
  privacy: Schema.Boolean,
  provincia: Schema.Literals(["MI", "RM", "TO"]),
  ragioneSociale: Schema.NonEmptyString,
});

const signatureRect = { bottom: 560, left: 72, right: 272, top: 610 } as const;

layer(pdfEngineLayer)("fields", (it) => {
  it.effect("reads every field with its type, value, and widgets", () =>
    Effect.gen(function* () {
      const document = yield* open(yield* formPdf);

      const fields = yield* document.fields;

      expect(fields.map(({ name, type, value }) => ({ name, type, value }))).toStrictEqual([
        { name: "ragioneSociale", type: pdfFieldTypes.text, value: "Azienda di Prova S.r.l." },
        { name: "privacy", type: pdfFieldTypes.checkbox, value: false },
        { name: "provincia", type: pdfFieldTypes.combobox, value: "MI" },
        { name: "pagamento", type: pdfFieldTypes.radio, value: undefined },
      ]);
      expect(fields.find(({ name }) => name === "pagamento")?.widgets).toHaveLength(2);
    }),
  );

  it.effect("fills the fields and keeps the values after a save", () =>
    Effect.gen(function* () {
      const document = yield* open(yield* formPdf);

      yield* document.setFields({
        pagamento: "contanti",
        privacy: true,
        provincia: "RM",
        ragioneSociale: "Studio di Prova & Partner — Società tra professionisti",
      });
      const saved = yield* document.save();

      const reread = yield* loadWithPdfLib(saved);
      const fields = reread.getForm();
      expect(fields.getTextField("ragioneSociale").getText()).toBe(
        "Studio di Prova & Partner — Società tra professionisti",
      );
      expect(fields.getCheckBox("privacy").isChecked()).toBe(true);
      expect(fields.getDropdown("provincia").getSelected()).toStrictEqual(["RM"]);
      expect(fields.getRadioGroup("pagamento").getSelected()).toBe("contanti");
    }),
  );

  it.effect.each([
    ["an unknown field", { codiceFiscale: "non presente nel modulo" }, "codiceFiscale"],
    ["a value of the wrong type", { privacy: "sì" }, "privacy"],
    ["a radio option that does not exist", { pagamento: "assegno" }, "pagamento"],
  ] as const)("rejects %s", ([, values, field]) =>
    Effect.gen(function* () {
      const document = yield* open(yield* formPdf);

      const error = yield* Effect.flip(document.setFields(values));

      expect(error).toBeInstanceOf(PdfFormError);
      expect(error).toMatchObject({ field });
    }),
  );
});

layer(pdfEngineLayer)("form codec", (it) => {
  it.effect("decodes the fields into the schema and writes a typed value back", () =>
    Effect.gen(function* () {
      const codec = form(Iscrizione);
      const document = yield* open(yield* formPdf);

      const read = yield* codec.read(document);
      yield* codec.write(document, { ...read, pagamento: "bonifico", privacy: true });
      const reopened = yield* open(yield* document.save());

      expect(read).toStrictEqual({
        privacy: false,
        provincia: "MI",
        ragioneSociale: "Azienda di Prova S.r.l.",
      });
      expect(yield* codec.read(reopened)).toStrictEqual({
        pagamento: "bonifico",
        privacy: true,
        provincia: "MI",
        ragioneSociale: "Azienda di Prova S.r.l.",
      });
    }),
  );

  it.effect("fails a form that does not match the schema", () =>
    Effect.gen(function* () {
      const document = yield* open(yield* formPdf);
      yield* document.setFields({ ragioneSociale: "" });

      const error = yield* Effect.flip(form(Iscrizione).read(document));

      expect(error).toBeInstanceOf(PdfFormError);
    }),
  );
});

layer(pdfEngineLayer)("signature fields", (it) => {
  it.effect.each([
    ["a document PDFium writes with an xref table", jpegScanPdf],
    ["a document saved with object streams", textPdf([["Contratto"]])],
  ] as const)("adds an empty signature field to %s and keeps the original bytes", ([, bytes]) =>
    Effect.gen(function* () {
      const original = yield* bytes;
      const document = yield* open(original);

      yield* document.addSignatureField({ name: "cliente-0-1", page: 0, rect: signatureRect });
      const saved = yield* document.save();

      expect(saved.subarray(0, original.length)).toStrictEqual(original);
      const reread = yield* loadWithPdfLib(saved);
      const [signature, ...others] = reread.getForm().getFields();
      expect(others).toStrictEqual([]);
      expect(signature).toBeInstanceOf(PDFSignature);
      expect(signature?.getName()).toBe("cliente-0-1");
      expect(signature?.acroField.getWidgets()[0]?.getRectangle()).toStrictEqual({
        height: 50,
        width: 200,
        x: 72,
        y: 560,
      });
      const reopened = yield* open(saved);
      expect(yield* reopened.fields).toStrictEqual([
        {
          name: "cliente-0-1",
          type: pdfFieldTypes.signature,
          value: undefined,
          widgets: [{ page: 0, rect: signatureRect }],
        },
      ]);
    }),
  );

  it.effect("reads a rectangle back as the decimals the PDF holds", () =>
    Effect.gen(function* () {
      const rect = { bottom: 712.589, left: 56.8, right: 220.8, top: 757.589 } as const;
      const document = yield* open(yield* textPdf([["Contratto"]]));

      yield* document.addSignatureField({ name: "cliente-0-0", page: 0, rect });
      const reopened = yield* open(yield* document.save());
      const [field] = yield* reopened.fields;

      expect(field?.widgets).toStrictEqual([{ page: 0, rect }]);
    }),
  );

  it.effect("reports the new field as a signature field before the save", () =>
    Effect.gen(function* () {
      const document = yield* open(yield* jpegScanPdf);

      yield* document.addSignatureField({ name: "computis-1", page: 0, rect: signatureRect });

      expect((yield* document.fields).map(({ type }) => type)).toStrictEqual([
        pdfFieldTypes.signature,
      ]);
    }),
  );

  it.effect("refuses a second field with the same name", () =>
    Effect.gen(function* () {
      const document = yield* open(yield* formPdf);

      const error = yield* Effect.flip(
        document.addSignatureField({ name: "privacy", page: 0, rect: signatureRect }),
      );

      expect(error).toMatchObject({ field: "privacy" });
    }),
  );
});
