import { Effect, Result } from "effect";
import { ParseOption, XmlDocument, XmlElement, XmlError } from "libxml2-wasm";
import { XsdCodegenError } from "../errors/xsd-codegen-error.ts";

export const XSD_NAMESPACE = "http://www.w3.org/2001/XMLSchema";

export interface XsdNode {
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: readonly XsdNode[];
  readonly line: number;
  readonly local: string;
  readonly namespaces: Readonly<Record<string, string>>;
  readonly path: string;
}

export const fail = (node: XsdNode, message: string) =>
  Result.fail(new XsdCodegenError({ message, path: `${node.path} (line ${String(node.line)})` }));

// oxlint-disable-next-line no-bitwise -- libxml2 parse options are bit flags
const PARSE_OPTION = ParseOption.XML_PARSE_NO_XXE | ParseOption.XML_PARSE_NONET;

const toNode = (element: XmlElement, parentPath: string): XsdNode => {
  const name = element.attr("name")?.value;
  const ref = element.attr("ref")?.value;
  const reference = ref === undefined ? "" : `[@ref="${ref}"]`;
  const path = `${parentPath}/xs:${element.name}${name === undefined ? reference : `[@name="${name}"]`}`;
  const children: XsdNode[] = [];
  for (let child = element.firstChild; child !== null; child = child.next) {
    if (
      child instanceof XmlElement &&
      child.namespaceUri === XSD_NAMESPACE &&
      child.name !== "annotation"
    ) {
      children.push(toNode(child, path));
    }
  }
  return {
    attributes: new Map(
      element.attrs
        .filter((attribute) => attribute.namespaceUri === "")
        .map((attribute) => [attribute.name, attribute.value]),
    ),
    children,
    line: element.line,
    local: element.name,
    namespaces: element.namespaces,
    path,
  };
};

export const readSchemaDocument = Effect.fn("XsdCodegen.readSchemaDocument")(
  function* readSchema(source: { readonly contents: Uint8Array; readonly url: string }) {
    return yield* Effect.acquireUseRelease(
      Effect.try({
        catch: (cause) =>
          new XsdCodegenError({
            cause,
            message: `The XSD could not be parsed: ${
              cause instanceof XmlError ? cause.message.trimEnd() : "libxml2 gave no diagnostic"
            }`,
            path: source.url,
          }),
        try: () =>
          XmlDocument.fromBuffer(source.contents, { option: PARSE_OPTION, url: source.url }),
      }),
      (document) =>
        document.root.namespaceUri === XSD_NAMESPACE && document.root.name === "schema"
          ? Effect.sync(() => toNode(document.root, ""))
          : Effect.fail(
              new XsdCodegenError({
                message: "The document root is not an xs:schema element.",
                path: source.url,
              }),
            ),
      (document) =>
        Effect.sync(() => {
          document.dispose();
        }),
    );
  },
);
