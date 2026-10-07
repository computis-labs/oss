import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { expect, layer } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { XsdSchemaError } from "../src/errors/xsd-schema-error.ts";
import { XsdValidationError } from "../src/errors/xsd-validation-error.ts";
import { FatturaXml } from "./fixtures/fattura.ts";
import { make } from "../src/index.ts";

const XSD_DIRECTORY = new URL("fixtures/xsd/", import.meta.url);
const fatturaXsdPath = fileURLToPath(new URL("Schema_VFPR12_v1.2.3.xsd", XSD_DIRECTORY));
const singleLineFattura = readFileSync(
  new URL("fixtures/fattura-1-linea.xml", import.meta.url),
  "utf-8",
);

const makeFatturaCodec = make(FatturaXml, { xsd: { path: fatturaXsdPath } });

layer(NodeServices.layer)("make", (it) => {
  it.effect("decodes, encodes and validates a FatturaPA document", () =>
    Effect.gen(function* () {
      const fatturaXml = yield* makeFatturaCodec;

      const fattura = yield* fatturaXml.decode(singleLineFattura);
      const encoded = yield* fatturaXml.encode(fattura);
      const exit = yield* Effect.exit(fatturaXml.validate(encoded));

      expect(encoded).toContain("<CodiceDestinatario>");
      expect(exit).toStrictEqual(Exit.void);
    }),
  );

  it.effect("fails validate with XsdValidationError for a document the XSD rejects", () =>
    Effect.gen(function* () {
      const fatturaXml = yield* makeFatturaCodec;

      const error = yield* Effect.flip(
        fatturaXml.validate(singleLineFattura.replace("<CAP>00100</CAP>", "<CAP>ABC</CAP>")),
      );

      expect(error).toBeInstanceOf(XsdValidationError);
      expect(error.issues).toHaveLength(1);
    }),
  );

  it.effect("fails with XsdSchemaError when the XSD cannot be compiled", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        make(FatturaXml, {
          xsd: { contents: readFileSync(fatturaXsdPath), url: "/nowhere/fattura.xsd" },
        }),
      );

      expect(error).toBeInstanceOf(XsdSchemaError);
    }),
  );

  it.effect("fails validate after the scope that built it is closed", () =>
    Effect.gen(function* () {
      const fatturaXml = yield* Effect.scoped(makeFatturaCodec);

      const exit = yield* Effect.exit(fatturaXml.validate(singleLineFattura));

      expect(exit).toStrictEqual(
        Exit.die(new Error("Xsd validator used after the scope that built it was closed")),
      );
    }),
  );
});
