import { fileURLToPath } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "@effect/vitest";
import { Effect, Exit, FileSystem, Option, Schema } from "effect";
import * as OrderDomain from "./fixtures/xsd-codegen/order-domain.gen.ts";
import { XsdCodegenError } from "../src/errors/xsd-codegen-error.ts";
import { codec } from "../src/index.ts";
import * as Xsd from "../src/xsd.ts";
import { parseDomainTarget } from "../src/xsd-codegen/domain.ts";
import { generate } from "../src/xsd-codegen/generate.ts";

const fixture = (name: string) =>
  fileURLToPath(new URL(`fixtures/xsd-codegen/${name}`, import.meta.url));

const ORDER_XSD = fixture("order.xsd");
const IMPORTER = fixture("order-domain.gen.ts");

const order = (customer: string, country: string) =>
  `<Order version="1.0"><Number>A-1</Number><Customer>${customer}</Customer><Line unit="kg"><Quantity>2</Quantity><Price>9.90</Price></Line>${country}</Order>`;

const ADA = "<FirstName>Ada</FirstName><LastName>Lovelace</LastName>";

const orderCodec = Effect.fromResult(codec(OrderDomain.Order));

const generateOrder = (module: string, name: string) =>
  Effect.gen(function* generateWithDomain() {
    const fs = yield* FileSystem.FileSystem;
    return yield* generate({
      domain: { export: name, importer: IMPORTER, module },
      root: "Order",
      xsd: { contents: yield* fs.readFile(ORDER_XSD).pipe(Effect.orDie), url: ORDER_XSD },
    });
  });

layer(NodeServices.layer, { timeout: 60_000 })("XSD code generation with a domain", (it) => {
  it.effect("wraps the XSD type in the function that the domain maps it to", () =>
    Effect.gen(function* test() {
      const { decode, encode } = yield* orderCodec;
      const validator = yield* Xsd.make({ schema: { path: ORDER_XSD } });

      const decoded = yield* decode(order(ADA, "<Country>FR</Country>"));
      const xml = yield* encode(decoded);

      expect(decoded.Line[0].Quantity).toBe(2);
      expect(yield* Effect.exit(validator.validate(xml))).toStrictEqual(Exit.void);
      expect(xml).toContain("<Quantity>2</Quantity>");
    }),
  );

  it.effect("keeps the XSD checks of the type under the domain function", () =>
    Effect.gen(function* test() {
      const { decode } = yield* orderCodec;
      const xml = order(ADA, "<Country>FR</Country>").replace(
        "<Quantity>2</Quantity>",
        "<Quantity>100</Quantity>",
      );

      const decoded = yield* Effect.exit(decode(xml));

      expect(Exit.isFailure(decoded)).toBe(true);
    }),
  );

  it.effect("applies an element key to that element and not to its type", () =>
    Effect.gen(function* test() {
      const { decode } = yield* orderCodec;
      const validator = yield* Xsd.make({ schema: { path: ORDER_XSD } });
      const xml = order(ADA, "<Country>fr</Country>");

      const xsd = yield* Effect.exit(validator.validate(xml));
      const decoded = yield* Effect.exit(decode(xml));

      expect(xsd).toStrictEqual(Exit.void);
      expect(Exit.isFailure(decoded)).toBe(true);
      expect(Schema.decodeUnknownSync(OrderDomain.CountryType)("fr")).toBe("fr");
    }),
  );

  it.effect("decodes an empty element to its default through the domain function", () =>
    Effect.gen(function* test() {
      const { decode } = yield* orderCodec;

      const decoded = yield* decode(order(ADA, "<Country/>"));

      expect(decoded.Country).toBe("IT");
    }),
  );

  it.effect("wraps a built-in type keyed xs:<type>", () =>
    Effect.gen(function* test() {
      const { decode } = yield* orderCodec;

      const upper = yield* decode(order(`${ADA}<Email>ADA</Email>`, "<Country/>"));
      const lower = yield* Effect.exit(decode(order(`${ADA}<Email>ada</Email>`, "<Country/>")));

      expect(upper.Customer.Email).toBe("ADA");
      expect(Exit.isFailure(lower)).toBe(true);
    }),
  );

  it.effect("imports the domain once and calls its functions by key", () =>
    Effect.gen(function* test() {
      const code = yield* generateOrder("./order-domain.ts", "domain");

      expect(code).toContain(`import { domain } from "./order-domain.ts";`);
      expect(code).toContain("export const QuantityType = domain.QuantityType(");
      expect(code).toContain(`export const XsToken = domain["xs:token"](`);
      expect(code).toContain(
        `Country: xsdDefaultKey(domain["OrderType.Country"](CountryType), "IT")`,
      );
    }),
  );

  it.effect("renames a domain that clashes with a generated type", () =>
    Effect.gen(function* test() {
      const code = yield* generateOrder("./order-domain.ts", "OrderType");

      expect(code).toContain(`import { OrderType as OrderType2 } from "./order-domain.ts";`);
      expect(code).toContain("export const CodeType = OrderType2.CodeType(Schema.String.check(");
      expect(code).toContain("export const OrderType = Schema.Struct(");
    }),
  );

  it.effect("resolves a domain module that a package exports only for import", () =>
    Effect.gen(function* test() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const packageDirectory = `${directory}/node_modules/esm-only-domain`;
      yield* fs.makeDirectory(packageDirectory, { recursive: true });
      yield* fs.writeFileString(
        `${packageDirectory}/package.json`,
        JSON.stringify({
          exports: { ".": { import: "./index.js" } },
          name: "esm-only-domain",
          type: "module",
        }),
      );
      yield* fs.writeFileString(
        `${packageDirectory}/index.js`,
        "export const domain = { CodeType: (self) => self };\n",
      );

      const code = yield* generate({
        domain: {
          export: "domain",
          importer: `${directory}/order.gen.ts`,
          module: "esm-only-domain",
        },
        root: "Order",
        xsd: { contents: yield* fs.readFile(ORDER_XSD).pipe(Effect.orDie), url: ORDER_XSD },
      });

      expect(code).toContain(`import { domain } from "esm-only-domain";`);
    }),
  );

  it.effect.each(["Schema", "root", "xsdPattern"])(
    "aliases a domain named %s like an import of the generated module",
    (name) =>
      Effect.gen(function* test() {
        const code = yield* generateOrder("./order-domain-reserved.ts", name);

        expect(code).toContain(`import { Schema } from "effect";`);
        expect(code).toContain(`import { ${name} as ${name}2 } from "./order-domain-reserved.ts";`);
        expect(code).toContain(`export const CodeType = ${name}2.CodeType(Schema.String.check(`);
      }),
  );

  it.effect.each([
    [
      "a module that does not resolve",
      "./missing.ts",
      "domain",
      "The module ./missing.ts of the domain cannot be resolved from the generated file.",
    ],
    [
      "a package that does not resolve",
      "@acme/missing-domain",
      "domain",
      "The module @acme/missing-domain of the domain cannot be resolved from the generated file.",
    ],
    [
      "a module without the export",
      "./order-domain.ts",
      "missing",
      "The module ./order-domain.ts does not export an object named missing, which the domain names.",
    ],
    [
      "an export that is not an object",
      "./order-domain.ts",
      "notADomain",
      "The module ./order-domain.ts does not export an object named notADomain, which the domain names.",
    ],
    [
      "an entry that is not a function",
      "./order-domain.ts",
      "withString",
      "The domain withString of the module ./order-domain.ts maps the type CodeType to a value that is not a function.",
    ],
    [
      "a type the root does not use",
      "./order-domain.ts",
      "unusedType",
      "No type or element that Order uses matches the override of the type MissingType.",
    ],
    [
      "an element of another type",
      "./order-domain.ts",
      "otherElement",
      "No type or element that Order uses matches the override of the element LineType.Country.",
    ],
  ] as const)("fails on %s", ([, module, name, message]) =>
    Effect.gen(function* test() {
      const error = yield* Effect.flip(generateOrder(module, name));

      expect(error).toBeInstanceOf(XsdCodegenError);
      expect(error.message).toBe(message);
    }),
  );

  it.effect("leaves no resolver module next to the generated file", () =>
    Effect.gen(function* test() {
      const fs = yield* FileSystem.FileSystem;
      yield* Effect.flip(generateOrder("@acme/missing-domain", "domain"));

      const entries = yield* fs.readDirectory(fixture(""));

      expect(entries.filter((entry) => entry.startsWith(".effect-xml-"))).toStrictEqual([]);
    }),
  );

  it.each([
    ["@acme/scalars#domain", { export: "domain", module: "@acme/scalars" }],
    ["#app/domain#domain", { export: "domain", module: "#app/domain" }],
  ] as const)("reads the CLI target %s as <module>#<export>", (target, expected) => {
    expect(parseDomainTarget(target)).toStrictEqual(Option.some(expected));
  });

  it.each(["scalars", "scalars#", "#domain"])("rejects the CLI target %s", (target) => {
    expect(parseDomainTarget(target)).toStrictEqual(Option.none());
  });
});
