import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "@effect/vitest";
import { Context, Effect, Exit, FileSystem, Layer, Path } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { FatturaElettronica } from "./fixtures/fattura-xsd.gen.ts";
import type { XsdValidationError } from "../src/errors/xsd-validation-error.ts";
import { codec } from "../src/index.ts";
import * as Xsd from "../src/xsd.ts";
import { generate } from "../src/xsd-codegen/generate.ts";

const FATTURA_XSD = "tests/fixtures/xsd/Schema_VFPR12_v1.2.3.xsd";
const GENERATED = "tests/fixtures/fattura-xsd.gen.ts";
const OFFICIAL_EXAMPLES = ["FPA01", "FPA02", "FPA03", "FPR01", "FPR03"];

class Fixtures extends Context.Service<
  Fixtures,
  {
    readonly read: (file: string) => Effect.Effect<string, unknown>;
    readonly validate: (xml: string) => Effect.Effect<void, XsdValidationError>;
  }
>()("effect-xml/tests/XsdCodegenFixtures") {}

const FixturesLive = Layer.effect(
  Fixtures,
  Effect.gen(function* loadFixtures() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* path.fromFileUrl(new URL("fixtures/", import.meta.url));
    const validator = yield* Xsd.make({
      schema: { path: path.join(directory, "xsd/Schema_VFPR12_v1.2.3.xsd") },
    });
    return {
      read: (file: string) => fs.readFileString(path.join(directory, file)),
      validate: validator.validate,
    };
  }),
).pipe(Layer.provideMerge(NodeServices.layer));

const generatedCodec = Effect.fromResult(
  codec(FatturaElettronica, { decoder: { unknownElements: "skip" } }),
);

layer(FixturesLive, { timeout: 120_000 })("Schema generated from the FatturaPA XSD", (it) => {
  it.effect("matches the generated fixture", () =>
    Effect.gen(function* test() {
      const { read } = yield* Fixtures;

      const code = yield* generate({
        format: { args: ["--stdin-filepath={file}"], command: "oxfmt", path: GENERATED },
        prefix: "p",
        root: "FatturaElettronica",
        runtime: "../../src/xsd-codegen/runtime.ts",
        xsd: { path: FATTURA_XSD },
      });

      expect(code).toBe(yield* read("fattura-xsd.gen.ts"));
    }),
  );

  it.effect.each([
    "fattura-1-linea.xml",
    "fattura-20-linee.xml",
    ...OFFICIAL_EXAMPLES.map((name) => `fatturapa/IT01234567890_${name}.xml`),
  ])("round-trips %s into a document accepted by the XSD", (file) =>
    Effect.gen(function* test() {
      const { read, validate } = yield* Fixtures;
      const { decode, encode } = yield* generatedCodec;

      const fattura = yield* decode(yield* read(file));
      const xml = yield* encode(fattura);

      expect(yield* Effect.exit(validate(xml))).toStrictEqual(Exit.void);
      expect(yield* decode(xml)).toStrictEqual(fattura);
    }),
  );

  it.effect("rejects the official FPR02 example that the XSD rejects", () =>
    Effect.gen(function* test() {
      const { read, validate } = yield* Fixtures;
      const { decode } = yield* generatedCodec;
      const xml = yield* read("fatturapa/IT01234567890_FPR02.xml");

      const xsd = yield* Effect.exit(validate(xml));
      const decoded = yield* Effect.exit(decode(xml));

      expect(Exit.isFailure(xsd)).toBe(true);
      expect(Exit.isFailure(decoded)).toBe(true);
    }),
  );

  it.effect.each([1, 2, 3])(
    "encodes Arbitrary invoices of seed %i into documents the XSD accepts and decodes back",
    (seed) =>
      Effect.gen(function* test() {
        const { validate } = yield* Fixtures;
        const { decode, encode } = yield* generatedCodec;
        const invoices = yield* Arbitrary.sampleEffect(Arbitrary.schema(FatturaElettronica), {
          count: 10,
          maxDiscards: 10_000,
          seed,
          size: 4,
        });

        const rejected: string[] = [];
        for (const invoice of invoices) {
          const exit = yield* Effect.exit(
            Effect.gen(function* roundTrip() {
              const xml = yield* encode(invoice);
              yield* validate(xml);
              const again = yield* encode(yield* decode(xml));
              return again === xml
                ? undefined
                : `round trip changed the document:\n${xml}\n${again}`;
            }),
          );
          if (Exit.isFailure(exit)) {
            rejected.push(String(exit.cause));
          } else if (exit.value !== undefined) {
            rejected.push(exit.value);
          }
        }

        expect(invoices).toHaveLength(10);
        expect(rejected).toStrictEqual([]);
      }),
  );
});
