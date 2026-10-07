/* oxlint-disable sort-keys -- XML is sequence-typed: the Struct field order is the element order under test, so sorting the keys changes the documents. */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FatturaXml } from "./fixtures/fattura.ts";
import { element, root } from "../src/annotations.ts";
import { compile } from "../src/plan.ts";
import type { ChildPlan, ElementPlan } from "../src/types.ts";

const compilePlan = (schema: Schema.Top) => Effect.fromResult(compile(schema));

const compileError = (schema: Schema.Top) => Effect.flip(compilePlan(schema));

const childArities = (plan: ElementPlan) => plan.sequence.map((child) => [child.name, child.arity]);

const childElement = (plan: ElementPlan, name: string): ElementPlan => {
  const child: ChildPlan | undefined = plan.children.get(name);
  if (child?.node.kind !== "element") {
    return expect.fail(`${name} is not an element`);
  }
  return child.node;
};

describe("compile", () => {
  it.effect("orders the sequence as the Struct fields and precomputes the tags", () =>
    Effect.gen(function* test() {
      const Invoice = Schema.Struct({
        Numero: Schema.String,
        Data: Schema.String,
        Causale: Schema.String,
      }).pipe(root("Invoice"));

      const plan = yield* compilePlan(Invoice);

      expect(plan.node.sequence.map((child) => [child.name, child.index])).toEqual([
        ["Numero", 0],
        ["Data", 1],
        ["Causale", 2],
      ]);
      expect(plan.node.children.get("Data")).toMatchObject({
        closeTag: "</Data>",
        name: "Data",
        openTag: "<Data>",
      });
    }),
  );

  it.effect("maps optionalKey, Array and NonEmptyArray to an arity", () =>
    Effect.gen(function* test() {
      const Invoice = Schema.Struct({
        Numero: Schema.String,
        Causale: Schema.optionalKey(Schema.String),
        Note: Schema.Array(Schema.String),
        Linea: Schema.NonEmptyArray(Schema.String),
      }).pipe(root("Invoice"));

      const plan = yield* compilePlan(Invoice);

      expect(childArities(plan.node)).toEqual([
        ["Numero", "one"],
        ["Causale", "optional"],
        ["Note", "many"],
        ["Linea", "many"],
      ]);
    }),
  );

  it.effect(
    "treats strings, string literals, template literals and encoded strings as leaves",
    () =>
      Effect.gen(function* test() {
        const Invoice = Schema.Struct({
          Codice: Schema.String.pipe(Schema.check(Schema.isMaxLength(3))),
          Tipo: Schema.Literal("TD01"),
          Esigibilita: Schema.Literals(["I", "D", "S"]),
          Riferimento: Schema.TemplateLiteral(["FT-", Schema.String]),
          Quantita: Schema.NumberFromString,
        }).pipe(root("Invoice"));

        const plan = yield* compilePlan(Invoice);

        expect(plan.node.sequence.map((child) => [child.name, child.node.kind])).toEqual([
          ["Codice", "leaf"],
          ["Tipo", "leaf"],
          ["Esigibilita", "leaf"],
          ["Riferimento", "leaf"],
          ["Quantita", "leaf"],
        ]);
      }),
  );

  it.effect("compiles a nested Struct into a nested element plan", () =>
    Effect.gen(function* test() {
      const Invoice = Schema.Struct({
        Sede: Schema.Struct({ Indirizzo: Schema.String, CAP: Schema.String }),
      }).pipe(root("Invoice"));

      const plan = yield* compilePlan(Invoice);

      expect(childArities(childElement(plan.node, "Sede"))).toEqual([
        ["Indirizzo", "one"],
        ["CAP", "one"],
      ]);
    }),
  );

  it.effect("merges a union of Structs into one choice element ordered for every member", () =>
    Effect.gen(function* test() {
      const Anagrafica = Schema.Union([
        Schema.Struct({ Denominazione: Schema.String, Titolo: Schema.optionalKey(Schema.String) }),
        Schema.Struct({
          Nome: Schema.String,
          Cognome: Schema.String,
          Titolo: Schema.optionalKey(Schema.String),
        }),
      ]);
      const Invoice = Schema.Struct({ Anagrafica }).pipe(root("Invoice"));

      const plan = yield* compilePlan(Invoice);

      expect(childArities(childElement(plan.node, "Anagrafica"))).toEqual([
        ["Denominazione", "optional"],
        ["Nome", "optional"],
        ["Cognome", "optional"],
        ["Titolo", "optional"],
      ]);
    }),
  );

  it.effect("keeps a child required when every union member requires it", () =>
    Effect.gen(function* test() {
      const Rappresentante = Schema.Union([
        Schema.Struct({ IdFiscaleIVA: Schema.String, Denominazione: Schema.String }),
        Schema.Struct({ IdFiscaleIVA: Schema.String, Nome: Schema.String }),
      ]);
      const Invoice = Schema.Struct({ Rappresentante }).pipe(root("Invoice"));

      const plan = yield* compilePlan(Invoice);

      expect(childArities(childElement(plan.node, "Rappresentante"))).toEqual([
        ["IdFiscaleIVA", "one"],
        ["Denominazione", "optional"],
        ["Nome", "optional"],
      ]);
    }),
  );

  it.effect("rejects a union whose members order the same children differently", () =>
    Effect.gen(function* test() {
      const Scelta = Schema.Union([
        Schema.Struct({ Primo: Schema.String, Secondo: Schema.String }),
        Schema.Struct({ Secondo: Schema.String, Primo: Schema.String }),
      ]);
      const Invoice = Schema.Struct({ Scelta }).pipe(root("Invoice"));

      const error = yield* compileError(Invoice);

      expect(error).toMatchObject({ _tag: "XmlPlanError", path: "Invoice.Scelta" });
    }),
  );

  it.effect("moves declared root attributes out of the sequence", () =>
    Effect.gen(function* test() {
      const Invoice = Schema.Struct({
        Header: Schema.String,
        versione: Schema.Literal("FPR12"),
        SistemaEmittente: Schema.optionalKey(Schema.String),
      }).pipe(root("Invoice", { attributes: ["versione", "SistemaEmittente"] }));

      const plan = yield* compilePlan(Invoice);

      expect(childArities(plan.node)).toEqual([["Header", "one"]]);
      expect([...plan.node.attributes.values()]).toEqual([
        { name: "versione" },
        { name: "SistemaEmittente" },
      ]);
    }),
  );

  it.effect("reads attributes of a nested Struct from the element annotation", () =>
    Effect.gen(function* test() {
      const Importo = Schema.Struct({
        Valore: Schema.String,
        valuta: Schema.String,
      }).pipe(element({ attributes: ["valuta"] }));
      const Invoice = Schema.Struct({ Importo }).pipe(root("Invoice"));

      const plan = yield* compilePlan(Invoice);

      const importo = childElement(plan.node, "Importo");
      expect(childArities(importo)).toEqual([["Valore", "one"]]);
      expect(importo.attributes.get("valuta")).toEqual({ name: "valuta" });
    }),
  );

  it.effect("rejects an attribute that is not a leaf", () =>
    Effect.gen(function* test() {
      const Invoice = Schema.Struct({
        meta: Schema.Struct({ autore: Schema.String }),
      }).pipe(
        Schema.annotate({ "@computis/effect-xml/root": { attributes: ["meta"], name: "Invoice" } }),
      );

      const error = yield* compileError(Invoice);

      expect(error).toMatchObject({ _tag: "XmlPlanError", path: "Invoice.meta" });
    }),
  );

  it.effect("rejects a declared attribute that the Struct does not have", () =>
    Effect.gen(function* test() {
      const Importo = Schema.Struct({ Valore: Schema.String }).pipe(
        Schema.annotate({ "@computis/effect-xml/element": { attributes: ["valuta"] } }),
      );
      const Invoice = Schema.Struct({ Importo }).pipe(root("Invoice"));

      const error = yield* compileError(Invoice);

      expect(error).toMatchObject({ _tag: "XmlPlanError", path: "Invoice.Importo.valuta" });
    }),
  );

  it.effect("puts the prefix and the namespace declaration in the root open tag", () =>
    Effect.gen(function* test() {
      const Invoice = Schema.Struct({ Numero: Schema.String }).pipe(
        root("Invoice", { namespace: "urn:example:invoice", prefix: "inv" }),
      );

      const plan = yield* compilePlan(Invoice);

      expect(plan).toMatchObject({
        closeTag: "</inv:Invoice>",
        name: "Invoice",
        namespace: "urn:example:invoice",
        openTagStart: '<inv:Invoice xmlns:inv="urn:example:invoice"',
      });
    }),
  );

  it.effect("declares a default namespace when there is no prefix", () =>
    Effect.gen(function* test() {
      const Invoice = Schema.Struct({ Numero: Schema.String }).pipe(
        root("Invoice", { namespace: "urn:example:invoice" }),
      );

      const plan = yield* compilePlan(Invoice);

      expect(plan.openTagStart).toBe('<Invoice xmlns="urn:example:invoice"');
      expect(plan.closeTag).toBe("</Invoice>");
    }),
  );

  it.effect("rejects a prefix without a namespace", () =>
    Effect.gen(function* test() {
      const Invoice = Schema.Struct({ Numero: Schema.String }).pipe(
        root("Invoice", { prefix: "inv" }),
      );

      const error = yield* compileError(Invoice);

      expect(error).toMatchObject({ _tag: "XmlPlanError", path: "Invoice" });
    }),
  );

  it.effect("requires the root annotation", () =>
    Effect.gen(function* test() {
      const error = yield* compileError(Schema.Struct({ Numero: Schema.String }));

      expect(error).toMatchObject({ _tag: "XmlPlanError", path: "" });
    }),
  );

  it.effect("rejects a numeric encoded field with its path", () =>
    Effect.gen(function* test() {
      const Invoice = Schema.Struct({
        Riepilogo: Schema.Struct({ Totale: Schema.Finite }),
      }).pipe(root("Invoice"));

      const error = yield* compileError(Invoice);

      expect(error).toMatchObject({ _tag: "XmlPlanError", path: "Invoice.Riepilogo.Totale" });
    }),
  );

  it.effect("points Schema.optional to Schema.optionalKey", () =>
    Effect.gen(function* test() {
      const Invoice = Schema.Struct({
        Causale: Schema.optional(Schema.String),
      }).pipe(root("Invoice"));

      const error = yield* compileError(Invoice);

      expect(error).toMatchObject({
        _tag: "XmlPlanError",
        message:
          "Schema.optional is not supported because undefined has no XML representation: use Schema.optionalKey.",
        path: "Invoice.Causale",
      });
    }),
  );

  it.effect("points Schema.NullOr to Schema.optionalKey", () =>
    Effect.gen(function* test() {
      const Invoice = Schema.Struct({
        Sede: Schema.NullOr(Schema.Struct({ Indirizzo: Schema.String })),
      }).pipe(root("Invoice"));

      const error = yield* compileError(Invoice);

      expect(error).toMatchObject({
        _tag: "XmlPlanError",
        message:
          "Schema.NullOr is not supported because null has no XML representation: use Schema.optionalKey.",
        path: "Invoice.Sede",
      });
    }),
  );

  it.effect("points an optional attribute to Schema.optionalKey", () =>
    Effect.gen(function* test() {
      const Invoice = Schema.Struct({
        Numero: Schema.String,
        versione: Schema.optional(Schema.String),
      }).pipe(
        Schema.annotate({
          "@computis/effect-xml/root": { attributes: ["versione"], name: "Invoice" },
        }),
      );

      const error = yield* compileError(Invoice);

      expect(error).toMatchObject({
        _tag: "XmlPlanError",
        message:
          "Schema.optional is not supported because undefined has no XML representation: use Schema.optionalKey.",
        path: "Invoice.versione",
      });
    }),
  );

  it.effect("rejects records", () =>
    Effect.gen(function* test() {
      const Invoice = Schema.Struct({
        Extra: Schema.Record(Schema.String, Schema.String),
      }).pipe(root("Invoice"));

      const error = yield* compileError(Invoice);

      expect(error).toMatchObject({ _tag: "XmlPlanError", path: "Invoice.Extra" });
    }),
  );

  it.effect("rejects tuples", () =>
    Effect.gen(function* test() {
      const Invoice = Schema.Struct({
        Coppia: Schema.Tuple([Schema.String, Schema.String]),
      }).pipe(root("Invoice"));

      const error = yield* compileError(Invoice);

      expect(error).toMatchObject({ _tag: "XmlPlanError", path: "Invoice.Coppia" });
    }),
  );

  it.effect("rejects recursive schemas", () =>
    Effect.gen(function* test() {
      interface CategoriaTree {
        readonly Nome: string;
        readonly Figli: readonly CategoriaTree[];
      }
      const Categoria: Schema.Codec<CategoriaTree> = Schema.Struct({
        Nome: Schema.String,
        Figli: Schema.Array(Schema.suspend(() => Categoria)),
      });
      const Catalogo = Schema.Struct({ Categoria }).pipe(root("Catalogo"));

      const error = yield* compileError(Catalogo);

      expect(error).toMatchObject({ _tag: "XmlPlanError", path: "Catalogo.Categoria.Figli" });
    }),
  );

  it.effect("compiles the FatturaPA schema generated from the XSD", () =>
    Effect.gen(function* test() {
      const plan = yield* compilePlan(FatturaXml);

      expect(plan.openTagStart).toBe(
        '<p:FatturaElettronica xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2"',
      );
      expect(childArities(plan.node)).toEqual([
        ["FatturaElettronicaHeader", "one"],
        ["FatturaElettronicaBody", "many"],
      ]);
      expect([...plan.node.attributes.keys()]).toEqual(["versione", "SistemaEmittente"]);
      const anagrafica = childElement(
        childElement(
          childElement(childElement(plan.node, "FatturaElettronicaHeader"), "CedentePrestatore"),
          "DatiAnagrafici",
        ),
        "Anagrafica",
      );
      expect(anagrafica.sequence.map((child) => child.name)).toEqual([
        "Denominazione",
        "Nome",
        "Cognome",
        "Titolo",
        "CodEORI",
      ]);
    }),
  );
});
