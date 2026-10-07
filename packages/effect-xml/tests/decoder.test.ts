/* oxlint-disable sort-keys -- XML is sequence-typed: the Struct field order is the element order under test, so sorting the keys changes the documents. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FatturaXml, fatturaFixtures } from "./fixtures/fattura.ts";
import { startsWith } from "./fixtures/messages.ts";
import { XmlParseError } from "../src/errors/xml-parse-error.ts";
import { codec, element, root } from "../src/index.ts";
import type { Encodable } from "../src/encoder.ts";

const NAMESPACE = "http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2";

const encodeFattura = Schema.encodeSync(FatturaXml);

const codecFor = <S extends Encodable>(schema: S, options?: Parameters<typeof codec>[1]) =>
  Effect.fromResult(codec(schema, options));

const fixtureXml = (slug: string) =>
  readFileSync(new URL(`fixtures/fattura-${slug}.xml`, import.meta.url), "utf-8");

const singleLine = fixtureXml("1-linea");

const singleLineWithXsi = singleLine.replace(
  "xmlns:p=",
  'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:p=',
);

const fatturaNamed = (name: string) => {
  const fixture = fatturaFixtures.find((candidate) => candidate.name === name);
  return fixture?.fattura ?? expect.fail(`fixture ${name} is missing`);
};

describe("decode on FatturaPA", () => {
  it.effect.each([
    ["1 linea", "1-linea"],
    ["20 linee", "20-linee"],
  ] as const)("decodes the indented %s document into the source invoice", ([name, slug]) =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml);

      const fattura = yield* decode(fixtureXml(slug));

      expect(encodeFattura(fattura)).toStrictEqual(encodeFattura(fatturaNamed(name)));
    }),
  );

  it.effect.each(fatturaFixtures.map((fixture) => [fixture.name, fixture.fattura] as const))(
    "round-trips the %s invoice through encode and decode",
    ([, source]) =>
      Effect.gen(function* test() {
        const { decode, encode } = yield* codecFor(FatturaXml);

        const fattura = yield* decode(yield* encode(source));

        expect(encodeFattura(fattura)).toStrictEqual(encodeFattura(source));
      }),
  );

  it.effect("accepts any prefix bound to the FatturaPA namespace", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml);
      const xml = singleLine
        .replaceAll("p:FatturaElettronica", "ns2:FatturaElettronica")
        .replace("xmlns:p=", "xmlns:ns2=");

      const fattura = yield* decode(xml);

      expect(fattura.versione).toBe("FPR12");
    }),
  );

  it.effect("rejects a root bound to another namespace", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml);

      const error = yield* Effect.flip(
        decode(singleLine.replace(NAMESPACE, "http://example.com/other")),
      );

      expect(error).toMatchObject({
        _tag: "XmlDecodeError",
        message: startsWith(
          `Invalid document namespace: expected ${NAMESPACE}, found http://example.com/other.`,
        ),
        path: "FatturaElettronica",
        position: { column: 39, line: 1 },
      });
    }),
  );

  it.effect("reports a field the Schema rejects with its path and position", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml);

      const error = yield* Effect.flip(
        decode(singleLine.replace("<CAP>00100</CAP>", "<CAP>ABC</CAP>")),
      );

      expect(error).toMatchObject({
        _tag: "XmlDecodeError",
        path: "FatturaElettronica.FatturaElettronicaHeader.CedentePrestatore.Sede.CAP",
        position: { column: 9, line: 25 },
      });
    }),
  );

  it.effect("describes the reason, the path and the position in the message", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml);

      const error = yield* Effect.flip(
        decode(singleLine.replace("<Provincia>RM</Provincia>", "<Provincia>RMA</Provincia>")),
      );

      expect(error.message).toBe(
        "Expected a string matching the XSD pattern [A-Z]{2} at FatturaElettronica.FatturaElettronicaHeader.CedentePrestatore.Sede.Provincia (line 27, column 9)",
      );
    }),
  );

  it.effect("reports a field the Schema rejects inside a list with its index and position", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml);

      const error = yield* Effect.flip(
        decode(singleLine.replace("<Data>2026-04-30</Data>", "<Data>30/04/2026</Data>")),
      );

      expect(error).toMatchObject({
        _tag: "XmlDecodeError",
        message: startsWith("Expected a valid xs:date value"),
        path: "FatturaElettronica.FatturaElettronicaBody[0].DatiGenerali.DatiGeneraliDocumento.Data",
        position: { column: 9, line: 55 },
      });
    }),
  );

  it.effect("reports the position of the list item the Schema rejects", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml);

      const error = yield* Effect.flip(
        decode(
          fixtureXml("20-linee").replace(
            "<NumeroLinea>2</NumeroLinea>",
            "<NumeroLinea>due</NumeroLinea>",
          ),
        ),
      );

      expect(error).toMatchObject({
        path: "FatturaElettronica.FatturaElettronicaBody[0].DatiBeniServizi.DettaglioLinee[1].NumeroLinea",
        position: { column: 9, line: 80 },
      });
    }),
  );

  it.effect("reports the position of a root attribute the Schema rejects", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml);

      const error = yield* Effect.flip(
        decode(singleLine.replace('versione="FPR12"', 'versione="X"')),
      );

      expect(error).toMatchObject({
        path: "FatturaElettronica.versione",
        position: { column: 61, line: 1 },
      });
    }),
  );

  it.effect("names the expected alternatives of a choice that matches none of them", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml);

      const error = yield* Effect.flip(
        decode(singleLine.replace("<Denominazione>Cliente Esempio S.p.A.</Denominazione>", "")),
      );

      expect(error).toMatchObject({
        _tag: "XmlDecodeError",
        message: startsWith("Expected one of Denominazione | Nome+Cognome."),
        path: "FatturaElettronica.FatturaElettronicaHeader.CessionarioCommittente.DatiAnagrafici.Anagrafica",
        position: { column: 9, line: 37 },
      });
    }),
  );

  it.effect("reports the missing field of the choice the document started", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml);

      const error = yield* Effect.flip(
        decode(
          singleLine.replace(
            "<Denominazione>Cliente Esempio S.p.A.</Denominazione>",
            "<Nome>Mario</Nome>",
          ),
        ),
      );

      expect(error).toMatchObject({
        _tag: "XmlDecodeError",
        message: startsWith("Missing key"),
        path: "FatturaElettronica.FatturaElettronicaHeader.CessionarioCommittente.DatiAnagrafici.Anagrafica.Cognome",
        position: { column: 9, line: 37 },
      });
    }),
  );

  it.effect("reports an unexpected element with its path and position", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml);
      const xml = singleLine.replace("<CAP>00100</CAP>", "<CAP>00100</CAP><Scala>B</Scala>");

      const error = yield* Effect.flip(decode(xml));

      expect(error).toMatchObject({
        _tag: "XmlDecodeError",
        message: startsWith("Unexpected element: Scala."),
        path: "FatturaElettronica.FatturaElettronicaHeader.CedentePrestatore.Sede",
        position: { line: 25 },
      });
    }),
  );

  it.effect("skips unknown elements such as a signature when asked to", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml, { decoder: { unknownElements: "skip" } });
      const xml = singleLine.replace(
        "</p:FatturaElettronica>",
        '<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignedInfo><ds:X>1</ds:X></ds:SignedInfo></ds:Signature></p:FatturaElettronica>',
      );

      const fattura = yield* decode(xml);

      expect(encodeFattura(fattura)).toStrictEqual(encodeFattura(fatturaNamed("1 linea")));
    }),
  );

  it.effect("rejects an undeclared attribute on a leaf", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml);

      const error = yield* Effect.flip(
        decode(singleLine.replace("<Comune>Roma</Comune>", '<Comune foo="1">Roma</Comune>')),
      );

      expect(error).toMatchObject({
        message: startsWith("Unexpected attribute: foo."),
        path: "FatturaElettronica.FatturaElettronicaHeader.CedentePrestatore.Sede.Comune",
        position: { column: 17, line: 26 },
      });
    }),
  );

  it.effect("rejects xsi:nil on a leaf", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml);

      const error = yield* Effect.flip(
        decode(
          singleLineWithXsi.replace(
            "<Comune>Roma</Comune>",
            '<Comune xsi:nil="true">Roma</Comune>',
          ),
        ),
      );

      expect(error).toMatchObject({
        message: startsWith("Unexpected attribute: xsi:nil."),
        path: "FatturaElettronica.FatturaElettronicaHeader.CedentePrestatore.Sede.Comune",
      });
    }),
  );

  it.effect("rejects xsi:schemaLocation below the root", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml);

      const error = yield* Effect.flip(
        decode(
          singleLineWithXsi.replace(
            "<DatiTrasmissione>",
            '<DatiTrasmissione xsi:schemaLocation="urn:x x.xsd">',
          ),
        ),
      );

      expect(error).toMatchObject({
        message: startsWith("Unexpected attribute: xsi:schemaLocation."),
        path: "FatturaElettronica.FatturaElettronicaHeader.DatiTrasmissione",
      });
    }),
  );

  it.effect("accepts xml: attributes on a leaf", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml);

      const fattura = yield* decode(
        singleLine.replace("<Comune>Roma</Comune>", '<Comune xml:lang="it">Roma</Comune>'),
      );

      expect(fattura.FatturaElettronicaHeader.CedentePrestatore.Sede.Comune).toBe("Roma");
    }),
  );

  it.effect("drops undeclared and prefixed attributes when asked to skip", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml, { decoder: { unknownElements: "skip" } });

      const fattura = yield* decode(
        singleLineWithXsi
          .replace("<Comune>Roma</Comune>", '<Comune foo="1" xsi:nil="true">Roma</Comune>')
          .replace("<DatiTrasmissione>", '<DatiTrasmissione bar="2">'),
      );

      expect(fattura.FatturaElettronicaHeader.CedentePrestatore.Sede.Comune).toBe("Roma");
      expect(fattura.FatturaElettronicaHeader.DatiTrasmissione.ProgressivoInvio).toBe("00001");
    }),
  );

  it.effect("accepts a child that resets the default namespace", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml);

      const fattura = yield* decode(
        singleLine.replace("<DatiTrasmissione>", '<DatiTrasmissione xmlns="">'),
      );

      expect(fattura.FatturaElettronicaHeader.DatiTrasmissione.ProgressivoInvio).toBe("00001");
    }),
  );

  it.effect("accepts a child whose own prefix is bound to the document namespace", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml);

      const fattura = yield* decode(
        singleLine
          .replace("<DatiTrasmissione>", `<q:DatiTrasmissione xmlns:q="${NAMESPACE}">`)
          .replace("</DatiTrasmissione>", "</q:DatiTrasmissione>"),
      );

      expect(fattura.FatturaElettronicaHeader.DatiTrasmissione.ProgressivoInvio).toBe("00001");
    }),
  );

  it.effect("rejects a child whose prefix is bound to another namespace", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml);

      const error = yield* Effect.flip(
        decode(
          singleLine
            .replace("<DatiTrasmissione>", '<x:DatiTrasmissione xmlns:x="urn:other">')
            .replace("</DatiTrasmissione>", "</x:DatiTrasmissione>"),
        ),
      );

      expect(error).toMatchObject({
        message: startsWith(
          `Element x:DatiTrasmissione is not in the document namespace ${NAMESPACE}.`,
        ),
        path: "FatturaElettronica.FatturaElettronicaHeader.DatiTrasmissione",
        position: { column: 5, line: 3 },
      });
    }),
  );

  it.effect("skips a child whose prefix is bound to another namespace when asked to", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml, { decoder: { unknownElements: "skip" } });
      const foreign =
        '<x:DatiTrasmissione xmlns:x="urn:other"><x:Nota>1</x:Nota></x:DatiTrasmissione>';

      const fattura = yield* decode(
        singleLine.replace("<DatiTrasmissione>", `${foreign}<DatiTrasmissione>`),
      );

      expect(fattura.FatturaElettronicaHeader.DatiTrasmissione.ProgressivoInvio).toBe("00001");
    }),
  );

  it.effect("checks the children of an element against the prefix it rebinds", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml);

      const error = yield* Effect.flip(
        decode(
          singleLine
            .replace("<DatiTrasmissione>", '<DatiTrasmissione xmlns:p="urn:other">')
            .replace(
              "<ProgressivoInvio>00001</ProgressivoInvio>",
              "<p:ProgressivoInvio>00001</p:ProgressivoInvio>",
            ),
        ),
      );

      expect(error).toMatchObject({
        message: startsWith(
          `Element p:ProgressivoInvio is not in the document namespace ${NAMESPACE}.`,
        ),
        path: "FatturaElettronica.FatturaElettronicaHeader.DatiTrasmissione.ProgressivoInvio",
        position: { column: 7, line: 8 },
      });
    }),
  );

  it.effect("restores the namespace bindings when the rebinding element closes", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml);

      const fattura = yield* decode(
        singleLine
          .replace("<DatiTrasmissione>", '<DatiTrasmissione xmlns:p="urn:other">')
          .replace("<Comune>Roma</Comune>", "<p:Comune>Roma</p:Comune>"),
      );

      expect(fattura.FatturaElettronicaHeader.CedentePrestatore.Sede.Comune).toBe("Roma");
    }),
  );

  it.effect("reports a malformed document as an XmlParseError", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml);

      const error = yield* Effect.flip(decode(singleLine.replace("</Sede>", "</Sedi>")));

      expect(error).toBeInstanceOf(XmlParseError);
      expect(error.message).toBe("Closing tag </Sedi> does not match <Sede> (line 29, column 7)");
    }),
  );
});

describe("decode on FatturaPA documents from other senders", () => {
  const DSIG = "http://www.w3.org/2000/09/xmldsig#";

  it.effect("decodes an Anagrafica with Nome and Cognome", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml);

      const fattura = yield* decode(
        singleLine.replace(
          "<Denominazione>Cliente Esempio S.p.A.</Denominazione>",
          "<Nome>Mario</Nome><Cognome>Rossi</Cognome>",
        ),
      );

      expect(
        fattura.FatturaElettronicaHeader.CessionarioCommittente.DatiAnagrafici.Anagrafica,
      ).toStrictEqual({
        Nome: "Mario",
        Cognome: "Rossi",
      });
    }),
  );

  it.effect("decodes the RappresentanteFiscale of the header and of the buyer", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml);

      const fattura = yield* decode(
        singleLine
          .replace(
            "</CedentePrestatore>",
            "</CedentePrestatore><RappresentanteFiscale><DatiAnagrafici><IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>11122233344</IdCodice></IdFiscaleIVA><Anagrafica><Nome>Anna</Nome><Cognome>Bianchi</Cognome></Anagrafica></DatiAnagrafici></RappresentanteFiscale>",
          )
          .replace(
            "</CessionarioCommittente>",
            "<RappresentanteFiscale><IdFiscaleIVA><IdPaese>FR</IdPaese><IdCodice>12345678901</IdCodice></IdFiscaleIVA><Denominazione>Rappresentanze S.r.l.</Denominazione></RappresentanteFiscale></CessionarioCommittente>",
          ),
      );

      expect(fattura.FatturaElettronicaHeader.RappresentanteFiscale).toStrictEqual({
        DatiAnagrafici: {
          IdFiscaleIVA: { IdPaese: "IT", IdCodice: "11122233344" },
          Anagrafica: { Nome: "Anna", Cognome: "Bianchi" },
        },
      });
      expect(
        fattura.FatturaElettronicaHeader.CessionarioCommittente.RappresentanteFiscale,
      ).toStrictEqual({
        IdFiscaleIVA: { IdPaese: "FR", IdCodice: "12345678901" },
        Denominazione: "Rappresentanze S.r.l.",
      });
    }),
  );

  it.effect("decodes the SistemaEmittente attribute of the root", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml);

      const fattura = yield* decode(
        singleLine.replace('versione="FPR12"', 'versione="FPR12" SistemaEmittente="ERP-1"'),
      );

      expect(fattura.SistemaEmittente).toBe("ERP-1");
    }),
  );

  it.effect("decodes a root bound to the default namespace", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml);
      const xml = singleLine
        .replaceAll("p:FatturaElettronica", "FatturaElettronica")
        .replace("xmlns:p=", "xmlns=");

      const fattura = yield* decode(xml);

      expect(xml).toContain(`<FatturaElettronica versione="FPR12" xmlns="${NAMESPACE}">`);
      expect(encodeFattura(fattura)).toStrictEqual(encodeFattura(fatturaNamed("1 linea")));
    }),
  );

  it.effect("decodes a document that puts the root prefix on every child", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml);
      const xml = singleLine.replaceAll(/<(?<slash>\/?)(?=[A-Z])/gu, "<$<slash>p:");

      const fattura = yield* decode(xml);

      expect(xml).toContain("<p:Denominazione>Cliente Esempio S.p.A.</p:Denominazione>");
      expect(encodeFattura(fattura)).toStrictEqual(encodeFattura(fatturaNamed("1 linea")));
    }),
  );

  it.effect("decodes a root with signature and schema declarations after a stylesheet", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml);
      const xml = singleLine
        .replace(
          "?><p:FatturaElettronica",
          '?><?xml-stylesheet type="text/xsl" href="fatturaordinaria_v1.2.2.xsl"?><p:FatturaElettronica',
        )
        .replace(
          'versione="FPR12"',
          `versione="FPR12" xmlns:ds="${DSIG}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${NAMESPACE} Schema_VFPR12.xsd"`,
        );

      const fattura = yield* decode(xml);

      expect(xml).toContain("<?xml-stylesheet");
      expect(encodeFattura(fattura)).toStrictEqual(encodeFattura(fatturaNamed("1 linea")));
    }),
  );

  it.effect("skips a signature whose elements carry attributes when asked to", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml, { decoder: { unknownElements: "skip" } });
      const signature = `<ds:Signature xmlns:ds="${DSIG}" Id="Signature1"><ds:SignedInfo Id="SignedInfo1"><ds:Reference URI="" Id="Reference1"><ds:DigestValue>AbC=</ds:DigestValue></ds:Reference></ds:SignedInfo><ds:SignatureValue Id="SignatureValue1">XyZ=</ds:SignatureValue></ds:Signature>`;

      const fattura = yield* decode(
        singleLine.replace("</p:FatturaElettronica>", `${signature}</p:FatturaElettronica>`),
      );

      expect(encodeFattura(fattura)).toStrictEqual(encodeFattura(fatturaNamed("1 linea")));
    }),
  );

  it.effect("decodes a whole invoice with a BOM and CRLF line endings", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml);
      const xml = `\uFEFF${singleLine.replaceAll("\n", "\r\n")}`;

      const fattura = yield* decode(xml);

      expect(xml).toContain("<CAP>00100</CAP>\r\n");
      expect(fattura.FatturaElettronicaHeader.CedentePrestatore.Sede.CAP).toBe("00100");
      expect(encodeFattura(fattura)).toStrictEqual(encodeFattura(fatturaNamed("1 linea")));
    }),
  );
});

describe("decode with namespace prefixes", () => {
  const DSIG = "http://www.w3.org/2000/09/xmldsig#";
  const modes = ["error", "skip"] as const;
  const beforeRootEnd = (content: string) =>
    singleLine.replace("</p:FatturaElettronica>", `${content}</p:FatturaElettronica>`);

  it.effect.each(modes)("rejects an element with an unbound prefix in %s mode", (mode) =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml, { decoder: { unknownElements: mode } });
      const xml = beforeRootEnd("<ds:Signature>x</ds:Signature>");

      const error = yield* Effect.flip(decode(xml));

      expect(error).toMatchObject({
        _tag: "XmlDecodeError",
        message: startsWith('Unbound namespace prefix "ds".'),
        path: "FatturaElettronica",
        position: { offset: xml.indexOf("<ds:Signature>") },
      });
    }),
  );

  it.effect.each(modes)("rejects an attribute with an unbound prefix in %s mode", (mode) =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml, { decoder: { unknownElements: mode } });
      const xml = singleLine.replace("<Comune>Roma</Comune>", '<Comune ds:Id="c1">Roma</Comune>');

      const error = yield* Effect.flip(decode(xml));

      expect(error).toMatchObject({
        _tag: "XmlDecodeError",
        message: startsWith('Unbound namespace prefix "ds".'),
        path: "FatturaElettronica.FatturaElettronicaHeader.CedentePrestatore.Sede.Comune",
        position: { offset: xml.indexOf("ds:Id") },
      });
    }),
  );

  it.effect("accepts a prefix declared on an ancestor of a skipped element", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml, { decoder: { unknownElements: "skip" } });
      const xml = beforeRootEnd(
        '<ds:Signature><ds:SignedInfo ds:Id="s1"><ds:X>1</ds:X></ds:SignedInfo></ds:Signature>',
      ).replace("xmlns:p=", `xmlns:ds="${DSIG}" xmlns:p=`);

      const fattura = yield* decode(xml);

      expect(encodeFattura(fattura)).toStrictEqual(encodeFattura(fatturaNamed("1 linea")));
    }),
  );

  it.effect("rejects a prefix declared only on a sibling", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml, { decoder: { unknownElements: "skip" } });
      const xml = beforeRootEnd(`<ds:Object xmlns:ds="${DSIG}">1</ds:Object><ds:Signature/>`);

      const error = yield* Effect.flip(decode(xml));

      expect(error).toMatchObject({
        message: startsWith('Unbound namespace prefix "ds".'),
        position: { offset: xml.indexOf("<ds:Signature/>") },
      });
    }),
  );

  it.effect.each(modes)("accepts xml:lang without a declaration in %s mode", (mode) =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml, { decoder: { unknownElements: mode } });
      const xml = singleLine.replace(
        "<Comune>Roma</Comune>",
        '<Comune xml:lang="it">Roma</Comune>',
      );

      const fattura = yield* decode(xml);

      expect(fattura.FatturaElettronicaHeader.CedentePrestatore.Sede.Comune).toBe("Roma");
    }),
  );

  it.effect("checks a prefixed attribute against a declaration later in the same tag", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(FatturaXml);
      const xml = singleLine.replace(
        "<Comune>Roma</Comune>",
        `<Comune ds:Id="c1" xmlns:ds="${DSIG}">Roma</Comune>`,
      );

      const error = yield* Effect.flip(decode(xml));

      expect(error).toMatchObject({
        message: startsWith("Unexpected attribute: ds:Id."),
        position: { offset: xml.indexOf("ds:Id") },
      });
    }),
  );
});

describe("decode on small schemas", () => {
  const Documento = Schema.Struct({
    Titolo: Schema.String,
    Righe: Schema.Array(Schema.String),
    Note: Schema.optionalKey(Schema.Array(Schema.String)),
    Quantita: Schema.NumberFromString,
  }).pipe(root("Documento"));

  it.effect("decodes a missing required array as empty and omits a missing optional one", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(Documento);

      const documento = yield* decode(
        "<Documento><Titolo>Offerta</Titolo><Quantita>2</Quantita></Documento>",
      );

      expect(documento).toStrictEqual({ Titolo: "Offerta", Righe: [], Quantita: 2 });
    }),
  );

  it.effect("decodes entities and CDATA and keeps the leaf text as written", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(Documento);

      const documento = yield* decode(
        "<Documento>\n  <Titolo>  a &amp; <![CDATA[<b>]]>  </Titolo>\n  <Quantita>1</Quantita>\n</Documento>",
      );

      expect(documento.Titolo).toBe("  a & <b>  ");
    }),
  );

  it.effect("keeps a leaf made only of whitespace", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(Documento);

      const documento = yield* decode(
        "<Documento><Titolo> </Titolo><Quantita>1</Quantita></Documento>",
      );

      expect(documento.Titolo).toBe(" ");
    }),
  );

  it.effect("trims the leaf text when trimText is true", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(Documento, { decoder: { trimText: true } });

      const documento = yield* decode(
        "<Documento>\n  <Titolo>  a &amp; <![CDATA[<b>]]>  </Titolo>\n  <Quantita>1</Quantita>\n</Documento>",
      );

      expect(documento.Titolo).toBe("a & <b>");
    }),
  );

  it.effect("rejects an element out of the Schema sequence", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(Documento);

      const error = yield* Effect.flip(
        decode("<Documento><Quantita>1</Quantita><Titolo>Offerta</Titolo></Documento>"),
      );

      expect(error).toMatchObject({
        message: startsWith("Element out of sequence: Titolo."),
        path: "Documento",
      });
    }),
  );

  it.effect("rejects a repeated element that is not an array", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(Documento);

      const error = yield* Effect.flip(
        decode("<Documento><Titolo>A</Titolo><Titolo>B</Titolo><Quantita>1</Quantita></Documento>"),
      );

      expect(error).toMatchObject({
        message: startsWith("Repeated element: Titolo."),
        path: "Documento",
      });
    }),
  );

  it.effect("names the array item in the path of a nested failure", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(Documento);

      const error = yield* Effect.flip(
        decode(
          "<Documento><Titolo>A</Titolo><Righe>x</Righe><Righe><Sotto/></Righe><Quantita>1</Quantita></Documento>",
        ),
      );

      expect(error).toMatchObject({ path: "Documento.Righe[1]" });
    }),
  );

  it.effect("decodes the attributes of nested elements", () =>
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
      const { decode } = yield* codecFor(Ordine);

      const ordine = yield* decode(
        '<Ordine><Testata data="2026-04-30"><Numero>7</Numero><Riga tipo="merce"><Codice>A1</Codice></Riga><Riga><Codice>B2</Codice></Riga></Testata></Ordine>',
      );

      expect(ordine).toStrictEqual({
        Testata: {
          data: "2026-04-30",
          Numero: "7",
          Riga: [{ tipo: "merce", Codice: "A1" }, { Codice: "B2" }],
        },
      });
    }),
  );

  it.effect("decodes children that carry a prefix", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(Documento);

      const documento = yield* decode(
        '<x:Documento xmlns:x="urn:x"><x:Titolo>A</x:Titolo><x:Righe>1</x:Righe><x:Righe>2</x:Righe><x:Quantita>1</x:Quantita></x:Documento>',
      );

      expect(documento).toStrictEqual({ Titolo: "A", Righe: ["1", "2"], Quantita: 1 });
    }),
  );

  it.effect("reports an element inside a leaf with the leaf in the path", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(Documento);

      const error = yield* Effect.flip(
        decode("<Documento><Titolo>A<b/></Titolo><Quantita>1</Quantita></Documento>"),
      );

      expect(error).toMatchObject({
        message: startsWith("Unexpected element: b."),
        path: "Documento.Titolo",
        position: { column: 21, line: 1 },
      });
    }),
  );

  it.effect("skips an unknown element inside a leaf and keeps the text around it", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(Documento, { decoder: { unknownElements: "skip" } });

      const documento = yield* decode(
        "<Documento><Titolo>a<x><y>q</y></x>b</Titolo><Righe>1<z/></Righe><Righe>2</Righe><Quantita>1</Quantita></Documento>",
      );

      expect(documento).toStrictEqual({ Titolo: "ab", Righe: ["1", "2"], Quantita: 1 });
    }),
  );

  it.effect("rejects a document nested deeper than maxDepth", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(Documento, {
        decoder: { maxDepth: 3, unknownElements: "skip" },
      });

      const error = yield* Effect.flip(
        decode("<Documento><Titolo>a<x><y>q</y></x></Titolo><Quantita>1</Quantita></Documento>"),
      );

      expect(error).toMatchObject({
        _tag: "XmlParseError",
        message: startsWith("Maximum element depth of 3 exceeded"),
        position: { column: 24, line: 1 },
      });
    }),
  );

  it.effect("rejects a lone surrogate in a leaf as it rejects a control character", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(Documento);

      const surrogate = yield* Effect.flip(
        decode("<Documento>\n<Titolo>a\uD83D</Titolo><Quantita>1</Quantita></Documento>"),
      );
      const control = yield* Effect.flip(
        decode("<Documento>\n<Titolo>a\u0001</Titolo><Quantita>1</Quantita></Documento>"),
      );

      expect(surrogate).toStrictEqual(control);
      expect(surrogate).toMatchObject({
        _tag: "XmlParseError",
        message: startsWith("Character not allowed in XML 1.0"),
        position: { column: 10, line: 2, offset: 21 },
      });
    }),
  );

  it.effect("rejects an unknown element with a lone surrogate in its name in skip mode", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(Documento, { decoder: { unknownElements: "skip" } });

      const error = yield* Effect.flip(
        decode("<Documento><Titolo>A</Titolo><Bad\uD800/><Quantita>1</Quantita></Documento>"),
      );

      expect(error).toMatchObject({
        _tag: "XmlParseError",
        message: startsWith("Character not allowed in XML 1.0"),
        position: { offset: 33 },
      });
    }),
  );
});

describe("decode with a default namespace", () => {
  const EXPECTED = "urn:expected";
  const Invoice = Schema.Struct({
    Header: Schema.Struct({ Number: Schema.String }),
    Note: Schema.optionalKey(Schema.String),
  }).pipe(root("Invoice", { namespace: EXPECTED }));

  it.effect("rejects an unprefixed child that declares another default namespace", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(Invoice);
      const xml = `<Invoice xmlns="${EXPECTED}"><Header><Number xmlns="urn:other">7</Number></Header></Invoice>`;

      const error = yield* Effect.flip(decode(xml));

      expect(error).toMatchObject({
        _tag: "XmlDecodeError",
        message: startsWith(`Element Number is not in the document namespace ${EXPECTED}.`),
        path: "Invoice.Header.Number",
        position: { offset: xml.indexOf("<Number") },
      });
    }),
  );

  it.effect("skips an unprefixed child that declares another default namespace when asked to", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(Invoice, { decoder: { unknownElements: "skip" } });

      const invoice = yield* decode(
        `<Invoice xmlns="${EXPECTED}"><Header><Number xmlns="urn:other">7</Number><Number>8</Number></Header></Invoice>`,
      );

      expect(invoice).toStrictEqual({ Header: { Number: "8" } });
    }),
  );

  it.effect("rejects a child that undeclares the default namespace of the root", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(Invoice);
      const xml = `<Invoice xmlns="${EXPECTED}"><Header xmlns=""><Number>7</Number></Header></Invoice>`;

      const error = yield* Effect.flip(decode(xml));

      expect(error).toMatchObject({
        _tag: "XmlDecodeError",
        message: startsWith(`Element Header is not in the document namespace ${EXPECTED}.`),
        path: "Invoice.Header",
        position: { offset: xml.indexOf("<Header") },
      });
    }),
  );

  it.effect("skips a child that undeclares the default namespace of the root when asked to", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(Invoice, { decoder: { unknownElements: "skip" } });

      const invoice = yield* decode(
        `<Invoice xmlns="${EXPECTED}"><Header xmlns=""><Number>7</Number></Header><Header><Number>8</Number></Header></Invoice>`,
      );

      expect(invoice).toStrictEqual({ Header: { Number: "8" } });
    }),
  );

  it.effect("rejects the unprefixed children of a prefixed element that changes the default", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(Invoice);
      const xml = `<p:Invoice xmlns:p="${EXPECTED}"><p:Header xmlns="urn:other"><Number>7</Number></p:Header></p:Invoice>`;

      const error = yield* Effect.flip(decode(xml));

      expect(error).toMatchObject({
        message: startsWith(`Element Number is not in the document namespace ${EXPECTED}.`),
        path: "Invoice.Header.Number",
        position: { offset: xml.indexOf("<Number") },
      });
    }),
  );

  it.effect("accepts children that declare the document namespace and restores the default", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(Invoice);

      const invoice = yield* decode(
        `<p:Invoice xmlns:p="${EXPECTED}"><Header xmlns="${EXPECTED}"><Number>7</Number></Header><Note>n</Note></p:Invoice>`,
      );

      expect(invoice).toStrictEqual({ Header: { Number: "7" }, Note: "n" });
    }),
  );

  it.effect("reports a root that undeclares the default namespace as in no namespace", () =>
    Effect.gen(function* test() {
      const { decode } = yield* codecFor(Invoice);

      const error = yield* Effect.flip(decode('<Invoice xmlns=""><Header/></Invoice>'));

      expect(error).toMatchObject({
        message: startsWith(`Invalid document namespace: expected ${EXPECTED}, found none.`),
      });
    }),
  );
});
