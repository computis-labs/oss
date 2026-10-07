/* oxlint-disable sort-keys -- XML is sequence-typed: the Struct field order is the element order under test, so sorting the keys changes the documents. */
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it, layer } from "@effect/vitest";
import { Context, Effect, Exit, FileSystem, Layer, Path, Result, Schema } from "effect";
import { FatturaXml, fatturaFixtures } from "./fixtures/fattura.ts";
import type { FatturaEncoded } from "./fixtures/fattura.ts";
import { startsWith } from "./fixtures/messages.ts";
import { element, root } from "../src/annotations.ts";
import type { XsdValidationError } from "../src/errors/xsd-validation-error.ts";
import * as Xsd from "../src/xsd.ts";
import type { Encodable, EncoderOptions } from "../src/encoder.ts";
import { codec } from "../src/index.ts";

const FATTURA_XSD = "fixtures/xsd/Schema_VFPR12_v1.2.3.xsd";

class Invoices extends Context.Service<
  Invoices,
  {
    readonly expectedXml: (slug: string) => Effect.Effect<string, unknown>;
    readonly validate: (xml: string) => Effect.Effect<void, XsdValidationError>;
  }
>()("effect-xml/tests/Invoices") {}

const InvoicesLive = Layer.effect(
  Invoices,
  Effect.gen(function* loadInvoices() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const schemaPath = yield* path.fromFileUrl(new URL(FATTURA_XSD, import.meta.url));
    const validator = yield* Xsd.make({ schema: { path: schemaPath } });
    const fixtureDirectory = yield* path.fromFileUrl(new URL("fixtures/", import.meta.url));
    const expectedXml = (slug: string) =>
      fs
        .readFileString(path.join(fixtureDirectory, `fattura-${slug}.expected.xml`))
        .pipe(Effect.map((contents) => contents.trimEnd()));
    return { expectedXml, validate: validator.validate };
  }),
).pipe(Layer.provide(NodeServices.layer));

const encoderFor = <S extends Encodable>(schema: S, options: Partial<EncoderOptions> = {}) =>
  Effect.fromResult(Result.map(codec(schema, { encoder: options }), (xml) => xml.encode));

const fatturaNamed = (name: string) => {
  const fixture = fatturaFixtures.find((candidate) => candidate.name === name);
  return fixture?.fattura ?? expect.fail(`fixture ${name} is missing`);
};

const fatturaChanged = (change: (source: FatturaEncoded) => FatturaEncoded) =>
  Schema.encodeEffect(FatturaXml)(fatturaNamed("1 linea")).pipe(
    Effect.map(change),
    Effect.flatMap(Schema.decodeUnknownEffect(FatturaXml)),
  );

layer(InvoicesLive, { timeout: 60_000 })("encoder on FatturaPA", (it) => {
  it.effect.each(fatturaFixtures.map((fixture) => fixture.name))(
    "encodes the fixture %s into XML accepted by the XSD",
    (name) =>
      Effect.gen(function* test() {
        const { validate } = yield* Invoices;
        const encode = yield* encoderFor(FatturaXml);

        const xml = yield* encode(fatturaNamed(name));

        expect(yield* Effect.exit(validate(xml))).toStrictEqual(Exit.void);
      }),
  );

  it.effect.each([
    ["1 linea", "1-linea"],
    ["20 linee", "20-linee"],
  ] as const)("encodes the fixture %s into the expected document", ([name, slug]) =>
    Effect.gen(function* test() {
      const { expectedXml } = yield* Invoices;
      const encode = yield* encoderFor(FatturaXml);

      const xml = yield* encode(fatturaNamed(name));

      expect(xml).toBe(yield* expectedXml(slug));
    }),
  );

  it.effect("indents the document on request without changing its content", () =>
    Effect.gen(function* test() {
      const { expectedXml, validate } = yield* Invoices;
      const encode = yield* encoderFor(FatturaXml, { indent: 2 });

      const xml = yield* encode(fatturaNamed("1 linea"));

      expect(yield* Effect.exit(validate(xml))).toStrictEqual(Exit.void);
      expect(xml).toContain(
        'versione="FPR12">\n  <FatturaElettronicaHeader>\n    <DatiTrasmissione>',
      );
      expect(xml.replaceAll(/>\s+</gu, "><")).toBe(yield* expectedXml("1-linea"));
    }),
  );

  it.effect("writes an Anagrafica given by Nome and Cognome in the XSD order", () =>
    Effect.gen(function* test() {
      const { expectedXml, validate } = yield* Invoices;
      const encode = yield* encoderFor(FatturaXml);
      const fattura = yield* fatturaChanged((source) => ({
        ...source,
        FatturaElettronicaHeader: {
          ...source.FatturaElettronicaHeader,
          CedentePrestatore: {
            ...source.FatturaElettronicaHeader.CedentePrestatore,
            DatiAnagrafici: {
              ...source.FatturaElettronicaHeader.CedentePrestatore.DatiAnagrafici,
              Anagrafica: { Cognome: "Rossi", Nome: "Mario" },
            },
          },
        },
      }));

      const xml = yield* encode(fattura);

      expect(xml).toBe(
        (yield* expectedXml("1-linea")).replace(
          "<Anagrafica><Denominazione>Fornitore Esempio S.r.l.</Denominazione></Anagrafica>",
          "<Anagrafica><Nome>Mario</Nome><Cognome>Rossi</Cognome></Anagrafica>",
        ),
      );
      expect(yield* Effect.exit(validate(xml))).toStrictEqual(Exit.void);
    }),
  );

  it.effect("writes SistemaEmittente as a root attribute after versione", () =>
    Effect.gen(function* test() {
      const { expectedXml, validate } = yield* Invoices;
      const encode = yield* encoderFor(FatturaXml);
      const fattura = yield* fatturaChanged((source) => ({
        ...source,
        SistemaEmittente: "GESTIONALE",
      }));

      const xml = yield* encode(fattura);

      expect(xml).toBe(
        (yield* expectedXml("1-linea")).replace(
          'versione="FPR12">',
          'versione="FPR12" SistemaEmittente="GESTIONALE">',
        ),
      );
      expect(yield* Effect.exit(validate(xml))).toStrictEqual(Exit.void);
    }),
  );
});

describe("codec encode", () => {
  const Nota = Schema.Struct({
    Testo: Schema.String,
    autore: Schema.optionalKey(Schema.String),
  }).pipe(element({ attributes: ["autore"] }));

  const Documento = Schema.Struct({
    Titolo: Schema.String,
    Sottotitolo: Schema.optionalKey(Schema.String),
    Nota: Schema.optionalKey(Schema.Array(Nota)),
    Quantita: Schema.NumberFromString,
    lingua: Schema.String,
  }).pipe(root("Documento", { attributes: ["lingua"] }));

  it.effect("writes the declaration, the root attributes and the fields in schema order", () =>
    Effect.gen(function* test() {
      const encode = yield* encoderFor(Documento);

      const xml = yield* encode({ lingua: "it", Quantita: 2, Titolo: "Offerta" });

      expect(xml).toBe(
        '<?xml version="1.0" encoding="UTF-8"?><Documento lingua="it"><Titolo>Offerta</Titolo><Quantita>2</Quantita></Documento>',
      );
    }),
  );

  it.effect("repeats every array item and writes element attributes", () =>
    Effect.gen(function* test() {
      const encode = yield* encoderFor(Documento);

      const xml = yield* encode({
        lingua: "it",
        Nota: [{ autore: "Anna", Testo: "Prima" }, { Testo: "Seconda" }],
        Quantita: 1,
        Sottotitolo: "Bozza",
        Titolo: "Offerta",
      });

      expect(xml).toBe(
        '<?xml version="1.0" encoding="UTF-8"?><Documento lingua="it"><Titolo>Offerta</Titolo><Sottotitolo>Bozza</Sottotitolo><Nota autore="Anna"><Testo>Prima</Testo></Nota><Nota><Testo>Seconda</Testo></Nota><Quantita>1</Quantita></Documento>',
      );
    }),
  );

  it.effect("writes the attributes of elements nested inside other elements", () =>
    Effect.gen(function* test() {
      const Riga = Schema.Struct({
        Codice: Schema.String,
        tipo: Schema.optionalKey(Schema.String),
      }).pipe(element({ attributes: ["tipo"] }));
      const Ordine = Schema.Struct({
        Testata: Schema.Struct({
          Numero: Schema.String,
          Riga: Schema.Array(Riga),
          data: Schema.String,
        }).pipe(element({ attributes: ["data"] })),
      }).pipe(root("Ordine"));
      const encode = yield* encoderFor(Ordine);

      const xml = yield* encode({
        Testata: {
          data: "2026-04-30",
          Numero: "7",
          Riga: [{ tipo: "merce", Codice: "A1" }, { Codice: "B2" }],
        },
      });

      expect(xml).toBe(
        '<?xml version="1.0" encoding="UTF-8"?><Ordine><Testata data="2026-04-30"><Numero>7</Numero><Riga tipo="merce"><Codice>A1</Codice></Riga><Riga><Codice>B2</Codice></Riga></Testata></Ordine>',
      );
    }),
  );

  it.effect("escapes markup characters in text", () =>
    Effect.gen(function* test() {
      const encode = yield* encoderFor(Documento);

      const xml = yield* encode({ lingua: "it", Quantita: 1, Titolo: "a < b & c > d\r" });

      expect(xml).toContain("<Titolo>a &lt; b &amp; c &gt; d&#13;</Titolo>");
    }),
  );

  it.effect("escapes quotes, markup and whitespace in attributes", () =>
    Effect.gen(function* test() {
      const encode = yield* encoderFor(Documento);

      const xml = yield* encode({ lingua: 'a"b<c&d\te\nf\rg>', Quantita: 1, Titolo: "Offerta" });

      expect(xml).toContain('<Documento lingua="a&quot;b&lt;c&amp;d&#9;e&#10;f&#13;g>">');
    }),
  );

  it.effect.each([
    ["U+0000", "\u0000"],
    ["U+0001", "\u0001"],
    ["U+001F", "\u001F"],
    ["U+FFFE", "\uFFFE"],
    ["U+FFFF", "\uFFFF"],
  ] as const)("rejects the character %s that XML 1.0 does not allow in text", ([code, char]) =>
    Effect.gen(function* test() {
      const encode = yield* encoderFor(Documento);

      const error = yield* Effect.flip(
        encode({
          lingua: "it",
          Nota: [{ Testo: "Prima" }, { Testo: `Sec${char}onda` }],
          Quantita: 1,
          Titolo: "Offerta",
        }),
      );

      expect(error).toMatchObject({
        _tag: "XmlEncodeError",
        message: startsWith(`Character ${code} is not allowed in XML 1.0.`),
        path: "Documento.Nota[1].Testo",
      });
    }),
  );

  it.effect.each([
    ["U+0001", "\u0001"],
    ["U+000E", "\u000E"],
    ["U+0010", "\u0010"],
    ["U+001F", "\u001F"],
    ["U+FFFE", "\uFFFE"],
    ["U+FFFF", "\uFFFF"],
  ] as const)("rejects the character %s that XML 1.0 does not allow in long text", ([code, char]) =>
    Effect.gen(function* test() {
      const encode = yield* encoderFor(Documento);

      const error = yield* Effect.flip(
        encode({ lingua: "it", Quantita: 1, Titolo: `${"a".repeat(200)}${char}` }),
      );

      expect(error).toMatchObject({
        _tag: "XmlEncodeError",
        message: startsWith(`Character ${code} is not allowed in XML 1.0.`),
        path: "Documento.Titolo",
      });
    }),
  );

  it.effect("escapes markup characters in long text", () =>
    Effect.gen(function* test() {
      const encode = yield* encoderFor(Documento);
      const long = "a".repeat(200);

      const xml = yield* encode({ lingua: "it", Quantita: 1, Titolo: `${long}<&>\t\n\r` });

      expect(xml).toContain(`<Titolo>${long}&lt;&amp;&gt;\t\n&#13;</Titolo>`);
    }),
  );

  it.effect("rejects a character XML 1.0 does not allow in an attribute", () =>
    Effect.gen(function* test() {
      const encode = yield* encoderFor(Documento);

      const error = yield* Effect.flip(
        encode({
          lingua: "it",
          Nota: [{ autore: "An\u0008na", Testo: "Prima" }],
          Quantita: 1,
          Titolo: "Offerta",
        }),
      );

      expect(error).toMatchObject({
        _tag: "XmlEncodeError",
        message: startsWith("Character U+0008 is not allowed in XML 1.0."),
        path: "Documento.Nota[0].autore",
      });
    }),
  );

  it.effect.each([
    ["a high surrogate in short text", { Titolo: "a\uD83Db" }, "U+D83D", "Documento.Titolo"],
    ["a low surrogate in short text", { Titolo: "\uDE00" }, "U+DE00", "Documento.Titolo"],
    [
      "a high surrogate at the end of long text",
      { Titolo: `${"a".repeat(200)}\uD800` },
      "U+D800",
      "Documento.Titolo",
    ],
    [
      "a low surrogate after a valid pair in long text",
      { Titolo: `${"a".repeat(200)}😀\uDFFF` },
      "U+DFFF",
      "Documento.Titolo",
    ],
    [
      "a high surrogate in an attribute",
      { Nota: [{ autore: "An\uDBFFna", Testo: "Prima" }] },
      "U+DBFF",
      "Documento.Nota[0].autore",
    ],
    [
      "a low surrogate in a list item",
      { Nota: [{ Testo: "Prima" }, { Testo: "\uDC00Seconda" }] },
      "U+DC00",
      "Documento.Nota[1].Testo",
    ],
  ] as const)("rejects %s", ([, fields, code, path]) =>
    Effect.gen(function* test() {
      const encode = yield* encoderFor(Documento);

      const error = yield* Effect.flip(
        encode({ lingua: "it", Quantita: 1, Titolo: "Offerta", ...fields }),
      );

      expect(error).toMatchObject({
        _tag: "XmlEncodeError",
        message: startsWith(`Character ${code} is not allowed in XML 1.0.`),
        path,
      });
    }),
  );

  it.effect("keeps characters outside the BMP in short text, long text and attributes", () =>
    Effect.gen(function* test() {
      const encode = yield* encoderFor(Documento);
      const long = `${"a".repeat(200)}😀`;

      const xml = yield* encode({
        lingua: "it",
        Nota: [{ autore: "𐍈", Testo: "😀" }],
        Quantita: 1,
        Titolo: long,
      });

      expect(xml).toContain(`<Titolo>${long}</Titolo>`);
      expect(xml).toContain('autore="𐍈"');
      expect(xml).toContain("<Testo>😀</Testo>");
    }),
  );

  it.effect("keeps tab, line feed and carriage return in text", () =>
    Effect.gen(function* test() {
      const encode = yield* encoderFor(Documento);

      const xml = yield* encode({ lingua: "it", Quantita: 1, Titolo: "a\tb\nc\rd" });

      expect(xml).toContain("<Titolo>a\tb\nc&#13;d</Titolo>");
    }),
  );

  it.effect("encodes again after rejecting a value", () =>
    Effect.gen(function* test() {
      const encode = yield* encoderFor(Documento);
      yield* Effect.flip(encode({ lingua: "it", Quantita: 1, Titolo: "a\u0000" }));

      const xml = yield* encode({ lingua: "it", Quantita: 1, Titolo: "Offerta" });

      expect(xml).toContain("<Titolo>Offerta</Titolo>");
    }),
  );

  it.effect("reports a schema failure as an XmlEncodeError with the path", () =>
    Effect.gen(function* test() {
      const Limitato = Schema.Struct({
        Righe: Schema.Array(
          Schema.Struct({ Codice: Schema.String.pipe(Schema.check(Schema.isMaxLength(3))) }),
        ),
      }).pipe(root("Limitato"));
      const encode = yield* encoderFor(Limitato);

      const error = yield* Effect.flip(encode({ Righe: [{ Codice: "A1" }, { Codice: "TROPPO" }] }));

      expect(error).toMatchObject({ _tag: "XmlEncodeError", path: "Limitato.Righe[1].Codice" });
      expect(error.message).toBe(
        "Expected a value with a length of at most 3 at Limitato.Righe[1].Codice",
      );
    }),
  );

  it.effect("fails with XmlPlanError when the schema has no root annotation", () =>
    Effect.gen(function* test() {
      const error = yield* Effect.flip(encoderFor(Schema.Struct({ Titolo: Schema.String })));

      expect(error).toMatchObject({ _tag: "XmlPlanError", path: "" });
    }),
  );
});
