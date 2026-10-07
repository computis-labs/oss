import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { PromptSyntaxErrorReason } from "../src/errors.ts";
import { parse } from "../src/parser.ts";

const failure = (source: string) => Effect.flip(parse(source, { path: "x.prompt.md" }));

describe("frontmatter", () => {
  it.effect("reads the description and starts the body after the closing line", () =>
    Effect.gen(function* () {
      const document = yield* parse("---\ndescription: Extract an invoice\n---\nBody\n");

      expect(document.frontmatter).toMatchObject({ description: "Extract an invoice" });
      expect(document.body).toMatchObject({ nodes: [{ _tag: "Text", value: "Body\n" }] });
    }),
  );

  it.effect("maps the mini type syntax to type nodes", () =>
    Effect.gen(function* () {
      const document = yield* parse(
        [
          "---",
          "input:",
          "  text?: String",
          "  total: Number",
          "  paid: Boolean",
          "  pdf: File",
          '  source: Literal("file", "text")',
          "  tags: Array(String)",
          "  note: NullOr(String)",
          "  customer:",
          "    name: String",
          "    vat?: String",
          "  lines: [{ description: String, amount: Number }]",
          "---",
          "",
        ].join("\n"),
      );

      expect(document.frontmatter?.input).toMatchObject({
        _tag: "Inline",
        type: {
          _tag: "Struct",
          fields: [
            { name: "text", optional: true, type: { _tag: "Primitive", name: "String" } },
            { name: "total", optional: false, type: { name: "Number" } },
            { name: "paid", type: { name: "Boolean" } },
            { name: "pdf", type: { name: "File" } },
            { name: "source", type: { _tag: "Literal", values: ["file", "text"] } },
            { name: "tags", type: { _tag: "Array", element: { name: "String" } } },
            { name: "note", type: { _tag: "NullOr", type: { name: "String" } } },
            {
              name: "customer",
              type: {
                _tag: "Struct",
                fields: [
                  { name: "name", optional: false },
                  { name: "vat", optional: true },
                ],
              },
            },
            {
              name: "lines",
              type: {
                _tag: "Array",
                element: {
                  _tag: "Struct",
                  fields: [
                    { name: "description", type: { name: "String" } },
                    { name: "amount", type: { name: "Number" } },
                  ],
                },
              },
            },
          ],
        },
      });
    }),
  );

  it.effect("reads a schema reference", () =>
    Effect.gen(function* () {
      const document = yield* parse(
        "---\nschema: '#/modules/invoice/prompt-input#InvoiceInput'\n---\n",
      );

      expect(document.frontmatter?.input).toEqual(
        expect.objectContaining({
          _tag: "Reference",
          exportName: "InvoiceInput",
          module: "#/modules/invoice/prompt-input",
        }),
      );
    }),
  );

  it.effect("points type errors at the type inside the YAML value", () =>
    Effect.gen(function* () {
      const error = yield* failure('---\ninput:\n  source: Literal("a", Strin)\n---\n');

      expect(error).toMatchObject({
        column: 24,
        line: 3,
        reason: PromptSyntaxErrorReason.InvalidType,
      });
    }),
  );

  it.effect("suggests the right type name", () =>
    Effect.gen(function* () {
      const error = yield* failure("---\ninput:\n  text: string\n---\n");

      expect(error).toMatchObject({
        column: 9,
        line: 3,
        reason: PromptSyntaxErrorReason.InvalidType,
      });
      expect(error.detail).toContain("Did you mean 'String'?");
    }),
  );

  it.effect("explains how to mark a field optional", () =>
    Effect.gen(function* () {
      const error = yield* failure("---\ninput:\n  text: optional(String)\n---\n");

      expect(error.detail).toContain("'text?: String'");
    }),
  );

  it.effect("suggests the closest frontmatter key", () =>
    Effect.gen(function* () {
      const error = yield* failure("---\ninputs:\n  text: String\n---\n");

      expect(error).toMatchObject({
        line: 2,
        reason: PromptSyntaxErrorReason.UnknownFrontmatterKey,
      });
      expect(error.detail).toContain("Did you mean 'input'?");
    }),
  );

  it.effect("rejects input together with schema", () =>
    Effect.gen(function* () {
      const error = yield* failure("---\ninput:\n  text: String\nschema: ./input.ts#Input\n---\n");

      expect(error).toMatchObject({ line: 4, reason: PromptSyntaxErrorReason.ConflictingInput });
    }),
  );

  it.effect("rejects a field that is declared twice", () =>
    Effect.gen(function* () {
      const error = yield* failure("---\ninput:\n  text: String\n  text?: String\n---\n");

      expect(error).toMatchObject({ line: 4, reason: PromptSyntaxErrorReason.DuplicateField });
    }),
  );

  it.effect("rejects a reserved field name", () =>
    Effect.gen(function* () {
      const error = yield* failure("---\ninput:\n  else: String\n---\n");

      expect(error.reason).toBe(PromptSyntaxErrorReason.InvalidIdentifier);
    }),
  );

  it.effect("rejects an array type with two element types", () =>
    Effect.gen(function* () {
      const error = yield* failure("---\ninput:\n  xs: [String, Number]\n---\n");

      expect(error.reason).toBe(PromptSyntaxErrorReason.InvalidType);
    }),
  );

  it.effect("rejects a schema reference without an export name", () =>
    Effect.gen(function* () {
      const error = yield* failure("---\nschema: ./input.ts\n---\n");

      expect(error.reason).toBe(PromptSyntaxErrorReason.InvalidSchemaReference);
    }),
  );

  it.effect("reports invalid YAML at its position", () =>
    Effect.gen(function* () {
      const error = yield* failure("---\ndescription: a\ndescription: b\n---\n");

      expect(error).toMatchObject({ line: 3, reason: PromptSyntaxErrorReason.InvalidYaml });
    }),
  );

  it.effect("rejects a frontmatter with no closing line", () =>
    Effect.gen(function* () {
      const error = yield* failure("---\ndescription: a\nBody\n");

      expect(error.reason).toBe(PromptSyntaxErrorReason.UnterminatedFrontmatter);
    }),
  );
});
