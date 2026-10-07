import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { expect, layer } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import { XmlLibError, XmlParseError } from "libxml2-wasm";
import * as Libxml2Diagnostics from "libxml2-wasm/lib/diag.mjs";
import { XsdSchemaError } from "../src/errors/xsd-schema-error.ts";
import { XsdValidationError } from "../src/errors/xsd-validation-error.ts";
import * as Xsd from "../src/xsd.ts";

const XSD_DIRECTORY = new URL("fixtures/xsd/", import.meta.url);
const fatturaXsdPath = fileURLToPath(new URL("Schema_VFPR12_v1.2.3.xsd", XSD_DIRECTORY));

const fixtures = ["1-linea", "20-linee"].map(
  (slug) =>
    [
      slug,
      readFileSync(new URL(`fixtures/fattura-${slug}.xml`, import.meta.url), "utf-8"),
    ] as const,
);

const singleLineFattura = fixtures[0]?.[1] ?? "";

const fatturaWithFourWrongFields = singleLineFattura
  .replace("<IdPaese>IT</IdPaese>", "<IdPaese>ita</IdPaese>")
  .replace("<CAP>00100</CAP>", "<CAP>ABC</CAP>")
  .replace("<Divisa>EUR</Divisa>", "<Divisa>EURO</Divisa>")
  .replace("<Data>2026-04-30</Data>", "<Data>30/04/2026</Data>");

const fatturaWithDoctype = (internalSubset: string, comune: string) =>
  singleLineFattura
    .replace(
      "?><p:FatturaElettronica",
      `?><!DOCTYPE p:FatturaElettronica [${internalSubset}]><p:FatturaElettronica`,
    )
    .replace("<Comune>Roma</Comune>", `<Comune>${comune}</Comune>`);

const makeFatturaValidator = Xsd.make({ schema: { path: fatturaXsdPath } });

layer(NodeServices.layer)("XSD validator", (it) => {
  it.effect.each(fixtures)("accepts the %s fixture", ([, xml]) =>
    Effect.gen(function* () {
      const validator = yield* makeFatturaValidator;

      const exit = yield* Effect.exit(validator.validate(xml));

      expect(exit).toStrictEqual(Exit.void);
    }),
  );

  it.effect("reports every wrong field with its line and message", () =>
    Effect.gen(function* () {
      const validator = yield* makeFatturaValidator;

      const error = yield* Effect.flip(validator.validate(fatturaWithFourWrongFields));

      expect(error).toBeInstanceOf(XsdValidationError);
      expect(
        error.issues.map(({ column, line, message }) => [line, column, message]),
      ).toStrictEqual([
        [5, 0, expect.stringContaining("'ita'")],
        [25, 0, expect.stringContaining("'ABC'")],
        [54, 0, expect.stringContaining("'EURO'")],
        [55, 0, expect.stringContaining("'30/04/2026'")],
      ]);
    }),
  );

  it.effect("describes every issue with its line and column in the message", () =>
    Effect.gen(function* () {
      const validator = yield* makeFatturaValidator;

      const error = yield* Effect.flip(
        validator.validate(
          singleLineFattura
            .replace("<IdPaese>IT</IdPaese>", "<IdPaese>ita</IdPaese>")
            .replace("<CAP>00100</CAP>", "<CAP>ABC</CAP>"),
        ),
      );

      expect(error.message).toBe(
        "XSD validation failed: Element 'IdPaese': [facet 'pattern'] The value 'ita' is not accepted by the pattern '[A-Z]{2}'. (line 5, column 0); Element 'CAP': [facet 'pattern'] The value 'ABC' is not accepted by the pattern '[0-9][0-9][0-9][0-9][0-9]'. (line 25, column 0)",
      );
    }),
  );

  it.effect("fails a malformed document with the parser issue", () =>
    Effect.gen(function* () {
      const validator = yield* makeFatturaValidator;

      const error = yield* Effect.flip(validator.validate("<FatturaElettronica><CAP></Sede>"));

      expect(error).toBeInstanceOf(XsdValidationError);
      expect(error.message).toBe(
        "XML document could not be parsed: Opening and ending tag mismatch: CAP line 1 and Sede (line 1, column 33)",
      );
      expect(
        error.issues.map(({ column, line, message }) => [line, column, message]),
      ).toStrictEqual([[1, 33, expect.stringContaining("Sede")]]);
    }),
  );

  it.effect("accepts a document with a DOCTYPE that declares no entity", () =>
    Effect.gen(function* () {
      const validator = yield* makeFatturaValidator;

      const exit = yield* Effect.exit(validator.validate(fatturaWithDoctype("", "Roma")));

      expect(exit).toStrictEqual(Exit.void);
    }),
  );

  it.effect.each([
    ["internal", '<!ENTITY comune "Roma">'],
    ["external", '<!ENTITY comune SYSTEM "file:///etc/hosts">'],
  ] as const)("does not expand an %s entity declared in the DOCTYPE", ([, declaration]) =>
    Effect.gen(function* () {
      const validator = yield* makeFatturaValidator;

      const error = yield* Effect.flip(
        validator.validate(fatturaWithDoctype(declaration, "&comune;")),
      );

      expect(error).toBeInstanceOf(XsdValidationError);
      expect(error.message).toMatch(
        /^XSD validation failed: .* \(entity references declared in the DOCTYPE are not expanded\)$/u,
      );
      expect(error.issues).toStrictEqual([]);
    }),
  );

  it.effect("reports an undeclared entity as a parse error", () =>
    Effect.gen(function* () {
      const validator = yield* makeFatturaValidator;

      const error = yield* Effect.flip(
        validator.validate(
          singleLineFattura.replace("<Comune>Roma</Comune>", "<Comune>&comune;</Comune>"),
        ),
      );

      expect(error.message).toBe(
        "XML document could not be parsed: Entity 'comune' not defined (line 26, column 25)",
      );
      expect(
        error.issues.map(({ column, line, message }) => [line, column, message]),
      ).toStrictEqual([[26, 25, expect.stringContaining("'comune'")]]);
    }),
  );

  it.effect("keeps the libxml2 error as the cause of a parse and a validation failure", () =>
    Effect.gen(function* () {
      const validator = yield* makeFatturaValidator;

      const parseFailure = yield* Effect.flip(
        validator.validate("<FatturaElettronica><CAP></Sede>"),
      );
      const validationFailure = yield* Effect.flip(validator.validate(fatturaWithFourWrongFields));

      expect(parseFailure.cause).toBeInstanceOf(XmlParseError);
      expect(validationFailure.cause).toBeInstanceOf(XmlLibError);
      expect(validationFailure.cause).not.toBeInstanceOf(XmlParseError);
    }),
  );

  it.effect("gives the same result for string and UTF-8 bytes input", () =>
    Effect.gen(function* () {
      const validator = yield* makeFatturaValidator;
      const bytes = new TextEncoder().encode(fatturaWithFourWrongFields);

      const fromString = yield* Effect.flip(validator.validate(fatturaWithFourWrongFields));
      const fromBytes = yield* Effect.flip(validator.validate(bytes));

      expect(fromBytes.issues).toHaveLength(4);
      expect(fromBytes.issues).toStrictEqual(fromString.issues);
    }),
  );

  it.effect("keeps non-ASCII text intact when a string is converted to bytes", () =>
    Effect.gen(function* () {
      const validator = yield* makeFatturaValidator;
      const xml = singleLineFattura.replace(
        "<Denominazione>Fornitore Esempio S.r.l.</Denominazione>",
        "<Denominazione>Società Città € Ωmega</Denominazione>",
      );

      const error = yield* Effect.flip(validator.validate(xml));

      expect(
        error.issues.map(({ column, line, message }) => [line, column, message]),
      ).toStrictEqual([[19, 0, expect.stringContaining("'Società Città € Ωmega'")]]);
    }),
  );

  it.effect("compiles a schema given as bytes, resolving imports against its url", () =>
    Effect.gen(function* () {
      const validator = yield* Xsd.make({
        schema: { contents: readFileSync(fatturaXsdPath), url: fatturaXsdPath },
      });

      const exit = yield* Effect.exit(validator.validate(singleLineFattura));

      expect(exit).toStrictEqual(Exit.void);
    }),
  );

  it.effect("frees the libxml2 memory of every document it validates", () =>
    Effect.gen(function* () {
      const validator = yield* makeFatturaValidator;
      const documents = [
        singleLineFattura,
        fatturaWithFourWrongFields,
        "<FatturaElettronica><CAP></Sede>",
        fatturaWithDoctype('<!ENTITY comune "Roma">', "&comune;"),
      ];

      const undisposed = yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          Libxml2Diagnostics.configure({ enabled: true });
        }),
        () =>
          Effect.forEach(
            Array.from({ length: 2000 }, (_, index) => documents[index % documents.length] ?? ""),
            (xml) => Effect.exit(validator.validate(xml)),
            { discard: true },
          ).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                Schema.decodeUnknownEffect(
                  Schema.Record(Schema.String, Schema.Struct({ totalInstances: Schema.Number })),
                )(Libxml2Diagnostics.report()),
              ),
            ),
          ),
        () =>
          Effect.sync(() => {
            Libxml2Diagnostics.configure({ enabled: false });
          }),
      );

      expect(
        Object.entries(undisposed).map(([name, { totalInstances }]) => [name, totalInstances]),
      ).toStrictEqual([]);
    }),
  );

  it.effect("fails after the scope that built it is closed", () =>
    Effect.gen(function* () {
      const validator = yield* Effect.scoped(makeFatturaValidator);

      const exit = yield* Effect.exit(validator.validate(singleLineFattura));

      expect(exit).toStrictEqual(
        Exit.die(new Error("Xsd validator used after the scope that built it was closed")),
      );
    }),
  );

  it.effect("fails with XsdSchemaError when the schema file does not exist", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Xsd.make({ schema: { path: fileURLToPath(new URL("missing.xsd", XSD_DIRECTORY)) } }),
      );

      expect(error).toBeInstanceOf(XsdSchemaError);
    }),
  );

  it.effect("fails with XsdSchemaError when an imported schema cannot be resolved", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Xsd.make({
          schema: { contents: readFileSync(fatturaXsdPath), url: "/nowhere/fattura.xsd" },
        }),
      );

      expect(error).toBeInstanceOf(XsdSchemaError);
    }),
  );

  it.effect("frees the schema document when the schema does not compile", () =>
    Effect.gen(function* () {
      const undisposed = yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          Libxml2Diagnostics.configure({ enabled: true });
        }),
        () =>
          Effect.scoped(
            Effect.flip(
              Xsd.make({
                schema: { contents: readFileSync(fatturaXsdPath), url: "/nowhere/fattura.xsd" },
              }),
            ),
          ).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown))(
                  Libxml2Diagnostics.report(),
                ),
              ),
            ),
          ),
        () =>
          Effect.sync(() => {
            Libxml2Diagnostics.configure({ enabled: false });
          }),
      );

      expect(Object.keys(undisposed)).toStrictEqual([]);
    }),
  );
});
