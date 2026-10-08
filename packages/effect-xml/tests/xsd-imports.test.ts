import { expect, layer } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Path } from "effect";
import { XsdSchemaError } from "../src/errors/xsd-schema-error.ts";
import { XsdValidationError } from "../src/errors/xsd-validation-error.ts";
import * as Xsd from "../src/xsd.ts";

const utf8 = new TextEncoder();

const ROOT = "/schemas/order dir/root.xsd";

const rootXsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:s="urn:example:signature">
  <xs:import namespace="urn:example:signature" schemaLocation="../shared/signature.xsd"/>
  <xs:element name="Order">
    <xs:complexType><xs:sequence><xs:element ref="s:Signature"/></xs:sequence></xs:complexType>
  </xs:element>
</xs:schema>`;

const signatureXsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns="urn:example:signature"
  targetNamespace="urn:example:signature" elementFormDefault="qualified">
  <xs:include schemaLocation="types/code.xsd"/>
  <xs:element name="Signature">
    <xs:complexType><xs:sequence><xs:element name="Value" type="Code"/></xs:sequence></xs:complexType>
  </xs:element>
</xs:schema>`;

const codeXsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:example:signature">
  <xs:simpleType name="Code">
    <xs:restriction base="xs:string"><xs:pattern value="[A-Z]{3}"/></xs:restriction>
  </xs:simpleType>
</xs:schema>`;

const files = new Map([
  [ROOT, utf8.encode(rootXsd)],
  ["/schemas/shared/signature.xsd", utf8.encode(signatureXsd)],
  ["/schemas/shared/types/code.xsd", utf8.encode(codeXsd)],
]);

const noop = FileSystem.makeNoop({});

const MemoryFileSystem = FileSystem.layerNoop({
  readFile: (path) => {
    const bytes = files.get(path);
    return bytes === undefined ? noop.readFile(path) : Effect.succeed(bytes);
  },
});

const order = (value: string) =>
  `<Order><s:Signature xmlns:s="urn:example:signature"><s:Value>${value}</s:Value></s:Signature></Order>`;

layer(Layer.mergeAll(MemoryFileSystem, Path.layer))(
  "XSD imports read through the FileSystem service",
  (it) => {
    it.effect.each([
      ["a path", { path: ROOT }],
      [
        "a file URL",
        { contents: utf8.encode(rootXsd), url: "file:///schemas/order%20dir/root.xsd" },
      ],
    ] as const)("follows imports and includes from a schema given as %s", ([, schema]) =>
      Effect.gen(function* test() {
        const validator = yield* Xsd.make({ schema });

        expect(yield* Effect.exit(validator.validate(order("ABC")))).toStrictEqual(Exit.void);
        expect(yield* Effect.flip(validator.validate(order("abc")))).toBeInstanceOf(
          XsdValidationError,
        );
      }),
    );

    it.effect("fails with XsdSchemaError when an imported schema is not on the FileSystem", () =>
      Effect.gen(function* test() {
        const error = yield* Effect.flip(
          Xsd.make({ schema: { contents: utf8.encode(rootXsd), url: "/elsewhere/root.xsd" } }),
        );

        expect(error).toBeInstanceOf(XsdSchemaError);
      }),
    );
  },
);
