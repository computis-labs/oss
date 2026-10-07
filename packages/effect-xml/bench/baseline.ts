// oxlint-disable-next-line test-boundary/no-test-imports -- the benchmarks are removed before the merge and share the test invoices until then
import { FatturaXml as FatturaElettronicaSchema } from "../tests/fixtures/fattura.ts";
import { Effect, Schema, SchemaAST, SchemaTransformation } from "effect";
import XMLBuilder from "fast-xml-builder";
import { XMLParser } from "fast-xml-parser";
import { validateXML } from "xmllint-wasm";

const NAMESPACE = "http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2";
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

const collectArrayElementNames = (
  ast: SchemaAST.AST,
  elementName?: string,
): ReadonlySet<string> => {
  if (SchemaAST.isArrays(ast)) {
    return new Set([
      ...(elementName === undefined ? [] : [elementName]),
      ...[...ast.elements, ...ast.rest].flatMap((element) => [
        ...collectArrayElementNames(element),
      ]),
    ]);
  }
  if (SchemaAST.isObjects(ast)) {
    return new Set(
      ast.propertySignatures.flatMap((property) => [
        ...collectArrayElementNames(property.type, String(property.name)),
      ]),
    );
  }
  if (SchemaAST.isUnion(ast)) {
    return new Set(
      ast.types.flatMap((member) => [...collectArrayElementNames(member, elementName)]),
    );
  }
  return new Set();
};

const FatturaDocumentSchema = Schema.Union([
  Schema.Struct({ FatturaElettronica: FatturaElettronicaSchema }).pipe(
    Schema.decodeTo(
      Schema.toType(FatturaElettronicaSchema),
      SchemaTransformation.transform({
        decode: (document) => document.FatturaElettronica,
        encode: (fattura) => ({ FatturaElettronica: fattura }),
      }),
    ),
  ),
  FatturaElettronicaSchema,
]);

export class BaselineDecodeError extends Schema.TaggedError<BaselineDecodeError>()(
  "BaselineDecodeError",
  { cause: Schema.Unknown },
) {}

export const makeBaseline = (xsd: {
  readonly dsig: { readonly contents: string; readonly fileName: string };
  readonly main: { readonly contents: string; readonly fileName: string };
}) => {
  const arrayElements = collectArrayElementNames(SchemaAST.toEncoded(FatturaElettronicaSchema.ast));
  const parser = new XMLParser({
    attributeNamePrefix: "",
    ignoreAttributes: false,
    isArray: (name) => arrayElements.has(name),
    parseAttributeValue: false,
    parseTagValue: false,
    removeNSPrefix: true,
    trimValues: true,
  });
  const compactBuilder = new XMLBuilder({
    attributeNamePrefix: "@_",
    ignoreAttributes: false,
    suppressEmptyNode: true,
  });
  const prettyBuilder = new XMLBuilder({
    attributeNamePrefix: "@_",
    format: true,
    ignoreAttributes: false,
    indentBy: "  ",
    suppressEmptyNode: true,
  });
  const encodeFattura = Schema.encodeSync(FatturaElettronicaSchema);
  const decodeParsed = Schema.decodeUnknownEffect(FatturaDocumentSchema);

  const buildDocument = (
    format: "compact" | "pretty",
    encoded: typeof FatturaElettronicaSchema.Encoded,
  ) => {
    const { SistemaEmittente, versione, ...elements } = encoded;
    const attributes =
      SistemaEmittente === undefined
        ? { "@_versione": versione }
        : { "@_SistemaEmittente": SistemaEmittente, "@_versione": versione };
    const root = {
      "p:FatturaElettronica": {
        ...attributes,
        "@_xmlns:p": NAMESPACE,
        ...elements,
      },
    };
    const document = format === "compact" ? compactBuilder.build(root) : prettyBuilder.build(root);
    return `${XML_DECLARATION}${document}`;
  };

  const decodeFatturaFromXml = (xml: string) =>
    Effect.try({
      catch: (cause) => new BaselineDecodeError({ cause }),
      try: () => {
        const parsed: unknown = parser.parse(xml);
        return parsed;
      },
    }).pipe(
      Effect.flatMap(decodeParsed),
      Effect.mapError((cause) => new BaselineDecodeError({ cause })),
    );

  return {
    buildDocument,
    decodeFatturaFromXml,
    decodeFatturaFromXmlSync: (xml: string) => Effect.runSync(decodeFatturaFromXml(xml)),
    encodeFattura,
    encodeFatturaToXml: (fattura: typeof FatturaElettronicaSchema.Type) =>
      buildDocument("compact", encodeFattura(fattura)),
    parser,
    prepareSchemaDecode: (xml: string) => {
      const parsed: unknown = parser.parse(xml);
      return () => Effect.runSync(decodeParsed(parsed));
    },
    validateInvoiceXml: async (xml: string) =>
      await validateXML({
        preload: xsd.dsig,
        schema: xsd.main,
        xml: { contents: xml, fileName: "invoice.xml" },
      }),
  };
};

export type Baseline = ReturnType<typeof makeBaseline>;
