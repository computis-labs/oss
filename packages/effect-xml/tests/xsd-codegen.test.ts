/* oxlint-disable sort-keys -- XML is sequence-typed: the Struct field order is the element order under test. */
import { fileURLToPath } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "@effect/vitest";
import { Effect, Exit, FileSystem, Path } from "effect";
import * as Order from "./fixtures/xsd-codegen/order.gen.ts";
import * as QualifiedOrder from "./fixtures/xsd-codegen/qualified-order.gen.ts";
import * as SignedOrder from "./fixtures/xsd-codegen/signed-order.gen.ts";
import { XsdCodegenError } from "../src/errors/xsd-codegen-error.ts";
import { codec } from "../src/index.ts";
import { compile } from "../src/plan.ts";
import * as Xsd from "../src/xsd.ts";
import { generate } from "../src/xsd-codegen/generate.ts";
import type { GenerateOptions } from "../src/xsd-codegen/generate.ts";
import { HELPERS } from "../src/xsd-codegen/simple-type/emit.ts";

const NAMESPACE = "urn:example:order";

const fixture = (name: string) =>
  fileURLToPath(new URL(`fixtures/xsd-codegen/${name}`, import.meta.url));

const ORDER_XSD = fixture("order.xsd");

const schemaDocument = (body: string, attributes = "") => `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" ${attributes}>
${body}
</xs:schema>
`;

const generateFrom = (xsd: string, options: Partial<GenerateOptions> = {}) =>
  generate({
    root: "Order",
    xsd: { contents: new TextEncoder().encode(xsd), url: fixture("inline.xsd") },
    ...options,
  });

const validatorFor = (path: string) => Xsd.make({ schema: { path } });

const orderCodec = Effect.fromResult(codec(Order.Order));

const ORDER_XML = `<Order version="1.0"><Number>A-1</Number><Customer><FirstName>Ada</FirstName><LastName>Lovelace</LastName></Customer><Line unit="kg"><Quantity>2</Quantity><Price>9.90</Price></Line><Line unit="m"><Quantity>1</Quantity><Price>1.00</Price></Line><Country/></Order>`;

const complexType = (content: string) =>
  schemaDocument(`<xs:element name="Order" type="OrderType"/>
  <xs:complexType name="OrderType">${content}</xs:complexType>`);

const simpleElement = (restriction: string) =>
  complexType(`<xs:sequence><xs:element name="Value">
    <xs:simpleType><xs:restriction base="xs:string">${restriction}</xs:restriction></xs:simpleType>
  </xs:element></xs:sequence>`);

const UNSUPPORTED = [
  [
    "xs:group",
    schemaDocument(`<xs:element name="Order"><xs:complexType><xs:group ref="G"/></xs:complexType></xs:element>
  <xs:group name="G"><xs:sequence><xs:element name="A" type="xs:string"/></xs:sequence></xs:group>`),
    'xs:element[@name="Order"]/xs:complexType/xs:group[@ref="G"]',
    "xs:group is not supported in a complex type.",
  ],
  [
    "xs:all",
    complexType(`<xs:all><xs:element name="A" type="xs:string"/></xs:all>`),
    'xs:complexType[@name="OrderType"]/xs:all',
    "xs:all is not supported in a complex type.",
  ],
  [
    "xs:any",
    complexType(`<xs:sequence><xs:any processContents="skip"/></xs:sequence>`),
    "xs:sequence/xs:any",
    "xs:any is not supported.",
  ],
  [
    "xs:list",
    complexType(`<xs:sequence><xs:element name="Value">
    <xs:simpleType><xs:list itemType="xs:string"/></xs:simpleType>
  </xs:element></xs:sequence>`),
    "xs:simpleType/xs:list",
    "xs:list simple types are not supported.",
  ],
  [
    "the totalDigits facet",
    simpleElement('<xs:totalDigits value="3"/>').replace("xs:string", "xs:decimal"),
    "xs:restriction/xs:totalDigits",
    "The totalDigits facet is not supported.",
  ],
  [
    "a Unicode category in a pattern",
    simpleElement(String.raw`<xs:pattern value="\d+"/>`),
    "xs:restriction/xs:pattern",
    String.raw`The escape \d depends on the Unicode tables of the validator`,
  ],
  [
    "a dash in the middle of a character class",
    simpleElement(`<xs:pattern value="[a-z-0]"/>`),
    "xs:restriction/xs:pattern",
    "A '-' inside a character class is only exact at its start or end",
  ],
  [
    "a repeated sequence",
    complexType(`<xs:sequence maxOccurs="2"><xs:element name="A" type="xs:string"/></xs:sequence>`),
    'xs:complexType[@name="OrderType"]/xs:sequence',
    "A repeated xs:sequence is not supported.",
  ],
  [
    "a recursive type",
    complexType(
      `<xs:sequence><xs:element name="Child" type="OrderType" minOccurs="0"/></xs:sequence>`,
    ),
    'xs:complexType[@name="OrderType"]',
    "Recursive types are not supported.",
  ],
  [
    "mixed content",
    complexType(`<xs:sequence/>`).replace('name="OrderType"', 'name="OrderType" mixed="true"'),
    'xs:complexType[@name="OrderType"]',
    'mixed="true" is not supported.',
  ],
  [
    "simple content",
    complexType(
      `<xs:simpleContent><xs:extension base="xs:string"><xs:attribute name="a" type="xs:string"/></xs:extension></xs:simpleContent>`,
    ),
    'xs:complexType[@name="OrderType"]/xs:simpleContent',
    "xs:simpleContent is not supported in a complex type.",
  ],
  [
    "a fixed element value",
    complexType(`<xs:sequence><xs:element name="A" type="xs:string" fixed="x"/></xs:sequence>`),
    'xs:element[@name="A"]',
    "Elements with a fixed value are not supported.",
  ],
  [
    "a nillable element",
    complexType(
      `<xs:sequence><xs:element name="A" type="xs:string" nillable="true"/></xs:sequence>`,
    ),
    'xs:element[@name="A"]',
    'nillable="true" is not supported.',
  ],
  [
    "maxOccurs zero",
    complexType(
      `<xs:sequence><xs:element name="A" type="xs:string" minOccurs="0" maxOccurs="0"/></xs:sequence>`,
    ),
    'xs:element[@name="A"]',
    'maxOccurs="0" is not supported.',
  ],
  [
    "an element name used twice",
    complexType(
      `<xs:sequence><xs:element name="A" type="xs:string"/><xs:element name="A" type="xs:string"/></xs:sequence>`,
    ),
    'xs:complexType[@name="OrderType"]',
    "A appears twice in the same content",
  ],
  [
    "an attribute reference",
    schemaDocument(`<xs:attribute name="lang" type="xs:string"/>
  <xs:element name="Order"><xs:complexType><xs:attribute ref="lang"/></xs:complexType></xs:element>`),
    'xs:attribute[@ref="lang"]',
    "Attribute references are not supported.",
  ],
  [
    "a built-in type outside the supported set",
    complexType(`<xs:sequence><xs:element name="A" type="xs:boolean"/></xs:sequence>`),
    'xs:element[@name="A"]',
    "The built-in type xs:boolean is not supported.",
  ],
  [
    "an element without a type",
    complexType(`<xs:sequence><xs:element name="A"/></xs:sequence>`),
    'xs:element[@name="A"]',
    "Elements without a type (xs:anyType) are not supported.",
  ],
  [
    "a missing root element",
    schemaDocument(`<xs:element name="Invoice" type="xs:string"/>`),
    "xs:schema",
    "The global element Order does not exist. Global elements: Invoice.",
  ],
  [
    "a simple root type",
    schemaDocument(`<xs:element name="Order" type="xs:string"/>`),
    'xs:element[@name="Order"]',
    "The root element must have a complex type.",
  ],
  [
    "a required element of another namespace",
    schemaDocument(
      `<xs:import namespace="urn:example:signature" schemaLocation="signature.xsd"/>
  <xs:element name="Order"><xs:complexType><xs:sequence>
    <xs:element ref="sig:Signature"/>
  </xs:sequence></xs:complexType></xs:element>`,
      `xmlns:sig="urn:example:signature"`,
    ),
    'xs:element[@ref="sig:Signature"]',
    "The required element sig:Signature belongs to another namespace",
  ],
] as const;

layer(NodeServices.layer, { timeout: 60_000 })("XSD code generation", (it) => {
  it.effect("turns sequences into Structs in the XSD order and choices into Unions", () =>
    Effect.gen(function* test() {
      const plan = yield* Effect.fromResult(compile(Order.Order));

      const customer = plan.node.children.get("Customer")?.node;

      expect(plan.node.sequence.map((child) => [child.name, child.arity])).toStrictEqual([
        ["Number", "one"],
        ["Customer", "one"],
        ["Line", "many"],
        ["Note", "many"],
        ["Tag", "many"],
        ["Country", "optional"],
      ]);
      expect(
        customer?.kind === "element"
          ? customer.sequence.map((child) => [child.name, child.optional])
          : [],
      ).toStrictEqual([
        ["Company", true],
        ["FirstName", true],
        ["LastName", true],
        ["Email", true],
      ]);
    }),
  );

  it.effect("decodes and encodes a document the XSD accepts", () =>
    Effect.gen(function* test() {
      const { decode, encode } = yield* orderCodec;
      const validator = yield* validatorFor(ORDER_XSD);

      const order = yield* decode(ORDER_XML);
      const xml = yield* encode(order);

      expect(order).toStrictEqual({
        Number: "A-1",
        Customer: { FirstName: "Ada", LastName: "Lovelace" },
        Line: [
          { Quantity: "2", Price: "9.90", unit: "kg" },
          { Quantity: "1", Price: "1.00", unit: "m" },
        ],
        Country: "IT",
        version: "1.0",
      });
      expect(yield* Effect.exit(validator.validate(xml))).toStrictEqual(Exit.void);
    }),
  );

  it.effect("declares the root attributes on root and the other attributes on element", () =>
    Effect.gen(function* test() {
      const plan = yield* Effect.fromResult(compile(Order.Order));
      const line = plan.node.children.get("Line")?.node;

      expect([...plan.node.attributes.values()]).toStrictEqual([
        { name: "version" },
        { name: "channel" },
      ]);
      expect(line?.kind === "element" ? [...line.attributes.values()] : []).toStrictEqual([
        { name: "unit" },
      ]);
    }),
  );

  it.effect.each([
    ["an undeclared enumeration value", ORDER_XML.replace('version="1.0"', 'version="3.0"')],
    ["a missing required attribute", ORDER_XML.replace(' unit="kg"', "")],
    [
      "too many occurrences",
      ORDER_XML.replace("<Country/>", "<Note>a</Note><Note>b</Note><Note>c</Note><Country/>"),
    ],
    [
      "a value outside minInclusive and maxInclusive",
      ORDER_XML.replace("<Quantity>2</Quantity>", "<Quantity>100</Quantity>"),
    ],
    [
      "a value that breaks the pattern",
      ORDER_XML.replace("<Price>9.90</Price>", "<Price>9.9</Price>"),
    ],
    ["a value of the wrong length", ORDER_XML.replace("<Country/>", "<Country>ITA</Country>")],
    [
      "both branches of a choice missing",
      ORDER_XML.replace(/<Customer>.*<\/Customer>/u, "<Customer></Customer>"),
    ],
  ] as const)("rejects %s like the XSD does", ([, xml]) =>
    Effect.gen(function* test() {
      const { decode } = yield* orderCodec;
      const validator = yield* validatorFor(ORDER_XSD);

      const decoded = yield* Effect.exit(decode(xml));

      expect(Exit.isFailure(yield* Effect.exit(validator.validate(xml)))).toBe(true);
      expect(Exit.isFailure(decoded)).toBe(true);
    }),
  );

  it("names anonymous types after their path and named types after the XSD", () => {
    expect(Object.keys(Order).toSorted()).toStrictEqual([
      "CodeType",
      "CountryType",
      "LineType",
      "LineTypePrice",
      "Order",
      "OrderType",
      "OrderTypeCustomer",
      "QuantityType",
      "VersionType",
      "XsString",
      "XsToken",
    ]);
  });

  it.effect.each(HELPERS)("renames the XSD type %s so that it keeps the runtime helper", (helper) =>
    Effect.gen(function* test() {
      const code = yield* generateFrom(
        schemaDocument(`<xs:element name="Order"><xs:complexType><xs:sequence>
    <xs:element name="Value" type="${helper}"/>
  </xs:sequence></xs:complexType></xs:element>
  <xs:simpleType name="${helper}"><xs:restriction base="xs:string"/></xs:simpleType>`),
      );

      expect(code).toContain(`export const ${helper}2 = `);
      expect(code).not.toContain(`export const ${helper} = `);
    }),
  );

  it.effect.each([
    ["xs:decimal", String.raw`[\-]?[0-9]{1,11}\.[0-9]{2}`, false],
    ["xs:decimal", String.raw`-?[0-9]{1,4}(\.[0-9]{1,2})?`, false],
    ["xs:decimal", String.raw`\+?[0-9]+`, false],
    ["xs:integer", "[0-9]{2,4}", false],
    ["xs:decimal", "[0-9.]{1,5}", true],
    ["xs:decimal", "[0-9]*", true],
    ["xs:decimal", String.raw`[0-9]*\.[0-9]+`, true],
    ["xs:integer", String.raw`[0-9]+\.[0-9]`, true],
    ["xs:integer", "[0-9+]{1,3}", true],
  ] as const)("on %s with the pattern %s keeps the lexical check: %s", ([base, pattern, kept]) =>
    Effect.gen(function* test() {
      const code = yield* generateFrom(
        simpleElement(`<xs:pattern value="${pattern}"/>`).replace("xs:string", base),
      );

      expect(code.includes("xsdLexical(")).toBe(kept);
    }),
  );

  it.effect("writes the same file for the same XSD", () =>
    Effect.gen(function* test() {
      const fs = yield* FileSystem.FileSystem;
      const xsd = yield* fs.readFileString(ORDER_XSD);

      const first = yield* generateFrom(xsd);
      const second = yield* generateFrom(xsd);

      expect(second).toBe(first);
    }),
  );

  it.effect("keeps a line break of the XSD file name inside the header comment", () =>
    Effect.gen(function* test() {
      const fs = yield* FileSystem.FileSystem;
      const xsd = yield* fs.readFileString(ORDER_XSD);

      const code = yield* generateFrom(xsd, {
        xsd: {
          contents: new TextEncoder().encode(xsd),
          url: "order\nexport const injected = 1;\u2028export const separated = 2;\r.xsd",
        },
      });

      expect(code).not.toMatch(/^export const (?:injected|separated)/mu);
      expect(code.split(/\r\n|[\n\r\u2028\u2029]/u)[0]).toContain("export const injected = 1;");
    }),
  );

  it.effect("passes the format arguments as given and replaces {file} with the path", () =>
    Effect.gen(function* test() {
      const fs = yield* FileSystem.FileSystem;
      const xsd = yield* fs.readFileString(ORDER_XSD);

      const code = yield* generateFrom(xsd, {
        format: {
          args: [
            "-e",
            "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
            "--",
            "a 'b' c",
            "--out={file}",
          ],
          command: process.execPath,
          path: "out dir/order.gen.ts",
        },
      });

      expect(JSON.parse(code)).toStrictEqual(["a 'b' c", "--out=out dir/order.gen.ts"]);
    }),
  );

  it.effect("leaves optional elements of another namespace out and notes them in the file", () =>
    Effect.gen(function* test() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { decode } = yield* Effect.fromResult(
        codec(SignedOrder.Order, { decoder: { unknownElements: "skip" } }),
      );

      const order = yield* decode(
        `<o:Order xmlns:o="${NAMESPACE}"><Number>7</Number><s:Signature xmlns:s="urn:example:signature"><s:Value>x</s:Value></s:Signature></o:Order>`,
      );
      const code = yield* fs.readFileString(
        path.join(path.dirname(fixture("signed-order.xsd")), "signed-order.gen.ts"),
      );

      expect(order).toStrictEqual({ Number: "7" });
      expect(code).toContain(
        "// - OrderType: sig:Signature (urn:example:signature), minOccurs 0, maxOccurs 1",
      );
    }),
  );

  it.effect("puts qualified local elements in the default namespace of the root", () =>
    Effect.gen(function* test() {
      const { encode } = yield* Effect.fromResult(codec(QualifiedOrder.Order));
      const validator = yield* validatorFor(fixture("qualified-order.xsd"));

      const xml = yield* encode({ Number: "7" });

      expect(yield* Effect.exit(validator.validate(xml))).toStrictEqual(Exit.void);
    }),
  );

  it.effect.each(UNSUPPORTED)("fails on %s with its path in the XSD", ([, xsd, path, message]) =>
    Effect.gen(function* test() {
      const error = yield* Effect.flip(generateFrom(xsd));

      expect(error).toBeInstanceOf(XsdCodegenError);
      expect(error.path).toContain(path);
      expect(error.message).toContain(message);
    }),
  );

  it.effect.each([
    ["unqualified local elements without a prefix", "", {}, "the root needs a prefix"],
    [
      "qualified local elements with a prefix",
      'elementFormDefault="qualified"',
      { prefix: "o" },
      "without a prefix",
    ],
  ] as const)("fails on %s", ([, form, options, message]) =>
    Effect.gen(function* test() {
      const xsd = schemaDocument(
        `<xs:element name="Order"><xs:complexType><xs:sequence>
    <xs:element name="Number" type="xs:string"/>
  </xs:sequence></xs:complexType></xs:element>`,
        `targetNamespace="${NAMESPACE}" ${form}`,
      );

      const error = yield* Effect.flip(generateFrom(xsd, options));

      expect(error.path).toContain("xs:schema");
      expect(error.message).toContain(message);
    }),
  );

  it.effect("fails on an XSD that libxml2 cannot compile", () =>
    Effect.gen(function* test() {
      const error = yield* Effect.flip(
        generateFrom(schemaDocument(`<xs:element name="Order" type="Missing"/>`)),
      );

      expect(error.path).toBe(fixture("inline.xsd"));
      expect(error.message).toContain("XSD schema could not be compiled");
    }),
  );

  it.effect("fails on an XSD file that does not exist", () =>
    Effect.gen(function* test() {
      const error = yield* Effect.flip(
        generate({ root: "Order", xsd: { path: "tests/fixtures/xsd/missing.xsd" } }),
      );

      expect(error.path).toBe("tests/fixtures/xsd/missing.xsd");
      expect(error.message).toBe("The XSD file could not be read.");
    }),
  );
});
