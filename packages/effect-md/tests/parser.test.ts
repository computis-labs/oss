import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { PromptSyntaxErrorReason } from "../src/errors.ts";
import { parse } from "../src/parser.ts";

const path = "invoice.prompt.md";

const failure = (source: string) => Effect.flip(parse(source, { path }));

describe("template body", () => {
  it.effect("reads text and variables as one fragment", () =>
    Effect.gen(function* () {
      const document = yield* parse("Hello {{customer.name}}, you owe {{total}}.");

      expect(document.body).toMatchObject({
        _tag: "Fragment",
        nodes: [
          { _tag: "Text", value: "Hello " },
          { _tag: "Output", value: { _tag: "Path", root: "customer", segments: ["name"] } },
          { _tag: "Text", value: ", you owe " },
          { _tag: "Output", value: { _tag: "Path", root: "total", segments: [] } },
          { _tag: "Text", value: "." },
        ],
      });
    }),
  );

  it.effect("records the source span of each node", () =>
    Effect.gen(function* () {
      const document = yield* parse("Hi {{name}}!");

      expect(document.body).toMatchObject({
        nodes: [
          { span: { end: 3, start: 0 } },
          { span: { end: 11, start: 3 }, value: { span: { end: 9, start: 5 } } },
          { span: { end: 12, start: 11 } },
        ],
      });
    }),
  );

  it.effect("reads helper calls with positional and named arguments", () =>
    Effect.gen(function* () {
      const document = yield* parse(`{{untrusted text tag="document" max=3}}`);

      expect(document.body).toMatchObject({
        nodes: [
          {
            _tag: "Helper",
            args: [{ _tag: "Path", root: "text" }],
            hash: [
              { name: "tag", value: { _tag: "Literal", value: "document" } },
              { name: "max", value: { _tag: "Literal", value: 3 } },
            ],
            name: "untrusted",
          },
        ],
      });
    }),
  );

  it.effect("reads if, else if and else branches with comparisons", () =>
    Effect.gen(function* () {
      const document = yield* parse(
        `{{#if source == "text"}}A{{else if source != null}}B{{else}}C{{/if}}`,
      );

      expect(document.body).toMatchObject({
        nodes: [
          {
            _tag: "If",
            alternate: [{ _tag: "Text", value: "C" }],
            branches: [
              {
                body: [{ _tag: "Text", value: "A" }],
                condition: {
                  _tag: "Compare",
                  left: { root: "source" },
                  operator: "==",
                  right: { value: "text" },
                },
              },
              {
                body: [{ _tag: "Text", value: "B" }],
                condition: { _tag: "Compare", operator: "!=", right: { value: null } },
              },
            ],
          },
        ],
      });
    }),
  );

  it.effect("reads unless as a negated condition", () =>
    Effect.gen(function* () {
      const document = yield* parse("{{#unless paid}}Unpaid{{/unless}}");

      expect(document.body).toMatchObject({
        nodes: [
          {
            _tag: "If",
            branches: [
              {
                condition: { _tag: "Not", condition: { _tag: "Truthy", value: { root: "paid" } } },
              },
            ],
          },
        ],
      });
    }),
  );

  it.effect("reads each with block params, data variables and an empty case", () =>
    Effect.gen(function* () {
      const document = yield* parse(
        "{{#each lines as |line i|}}{{@index}}:{{line.text}}{{else}}none{{/each}}",
      );

      expect(document.body).toMatchObject({
        nodes: [
          {
            _tag: "Each",
            alternate: [{ _tag: "Text", value: "none" }],
            body: [
              { _tag: "Output", value: { _tag: "Data", name: "index" } },
              { _tag: "Text", value: ":" },
              { _tag: "Output", value: { root: "line", segments: ["text"] } },
            ],
            index: "i",
            item: "line",
            iterable: { root: "lines" },
          },
        ],
      });
    }),
  );

  it.effect("removes block tags that stand alone on their line", () =>
    Effect.gen(function* () {
      const document = yield* parse("Start\n  {{#if a}}\nInside\n  {{/if}}\nEnd\n");

      expect(document.body).toMatchObject({
        nodes: [
          { _tag: "Text", value: "Start\n" },
          { _tag: "If", branches: [{ body: [{ _tag: "Text", value: "Inside\n" }] }] },
          { _tag: "Text", value: "End\n" },
        ],
      });
    }),
  );

  it.effect("keeps the line when a block tag shares it with text", () =>
    Effect.gen(function* () {
      const document = yield* parse("Total {{#if a}}yes{{/if}}\n");

      expect(document.body).toMatchObject({
        nodes: [{ _tag: "Text", value: "Total " }, { _tag: "If" }, { _tag: "Text", value: "\n" }],
      });
    }),
  );

  it.effect("strips whitespace next to a tag with a tilde", () =>
    Effect.gen(function* () {
      const document = yield* parse("A  \n  {{~name~}}  \n  B");

      expect(document.body).toMatchObject({
        nodes: [{ _tag: "Text", value: "A" }, { _tag: "Output" }, { _tag: "Text", value: "B" }],
      });
    }),
  );

  it.effect("drops comments and their standalone lines", () =>
    Effect.gen(function* () {
      const document = yield* parse("A\n{{! short note }}\nB {{!-- a }} long {{note}} --}}C\n");

      expect(document.body).toMatchObject({
        nodes: [
          { _tag: "Text", value: "A\n" },
          { _tag: "Text", value: "B " },
          { _tag: "Text", value: "C\n" },
        ],
      });
    }),
  );

  it.effect("keeps an escaped tag as text", () =>
    Effect.gen(function* () {
      const document = yield* parse(String.raw`Write \{{name}} to get {{name}}.`);

      expect(document.body).toMatchObject({
        nodes: [
          { _tag: "Text", value: "Write {{name}} to get " },
          { _tag: "Output" },
          { _tag: "Text", value: "." },
        ],
      });
    }),
  );

  it.effect("reads partials with their indent and named arguments", () =>
    Effect.gen(function* () {
      const document = yield* parse(`  {{> ./contract.md}}\n{{> "./line item.md" item=line}}`);

      expect(document.body).toMatchObject({
        nodes: [
          { _tag: "Partial", hash: [], indent: "  ", source: "./contract.md" },
          {
            _tag: "Partial",
            hash: [{ name: "item", value: { root: "line" } }],
            indent: "",
            source: "./line item.md",
          },
        ],
      });
    }),
  );
});

describe("role blocks", () => {
  it.effect("splits the body into messages", () =>
    Effect.gen(function* () {
      const document = yield* parse(
        "<system>\nYou are an accountant.\n</system>\n\n<user>\nRead {{text}}\n</user>\n",
      );

      expect(document.body).toMatchObject({
        _tag: "Messages",
        messages: [
          { body: [{ _tag: "Text", value: "You are an accountant.\n" }], role: "system" },
          {
            body: [
              { _tag: "Text", value: "Read " },
              { _tag: "Output" },
              { _tag: "Text", value: "\n" },
            ],
            role: "user",
          },
        ],
      });
    }),
  );

  it.effect("keeps role tags that are not at the start of a line as text", () =>
    Effect.gen(function* () {
      const document = yield* parse("Wrap it in <user> tags.\n\\<user>\n");

      expect(document.body).toMatchObject({
        _tag: "Fragment",
        nodes: [{ _tag: "Text", value: "Wrap it in <user> tags.\n<user>\n" }],
      });
    }),
  );

  it.effect("rejects a role tag with text on the same line", () =>
    Effect.gen(function* () {
      const error = yield* failure("<system>You are an accountant.\n</system>\n");

      expect(error).toMatchObject({
        column: 1,
        line: 1,
        reason: PromptSyntaxErrorReason.InvalidRoleTag,
      });
    }),
  );

  it.effect("rejects text outside the role blocks", () =>
    Effect.gen(function* () {
      const error = yield* failure("Intro\n<user>\nHi\n</user>\n");

      expect(error).toMatchObject({ line: 1, reason: PromptSyntaxErrorReason.TextOutsideRole });
    }),
  );

  it.effect("rejects a role tag inside a block", () =>
    Effect.gen(function* () {
      const error = yield* failure("{{#if a}}\n<user>\nHi\n</user>\n{{/if}}\n");

      expect(error).toMatchObject({ line: 2, reason: PromptSyntaxErrorReason.RoleInsideBlock });
    }),
  );

  it.effect("rejects a role that is not closed", () =>
    Effect.gen(function* () {
      const error = yield* failure("<system>\nA\n<user>\nB\n</user>\n");

      expect(error).toMatchObject({ line: 3, reason: PromptSyntaxErrorReason.UnclosedRole });
    }),
  );
});

describe("syntax errors", () => {
  it.effect("points at the block that is not closed", () =>
    Effect.gen(function* () {
      const error = yield* failure("Line one\n  {{#if a}}\nText\n");

      expect(error).toMatchObject({
        column: 3,
        line: 2,
        path,
        reason: PromptSyntaxErrorReason.UnclosedBlock,
      });
      expect(error.message).toBe("invoice.prompt.md:2:3 {{#if}} has no closing '{{/if}}'.");
    }),
  );

  it.effect("names the open block when a closing tag does not match", () =>
    Effect.gen(function* () {
      const error = yield* failure("{{#each items as |item|}}\n{{/if}}\n");

      expect(error).toMatchObject({ line: 2, reason: PromptSyntaxErrorReason.MismatchedClose });
      expect(error.detail).toContain("from line 1");
    }),
  );

  it.effect("suggests the closest block name", () =>
    Effect.gen(function* () {
      const error = yield* failure("{{#iff a}}x{{/iff}}");

      expect(error.reason).toBe(PromptSyntaxErrorReason.UnknownBlock);
      expect(error.detail).toContain("Did you mean 'if'?");
    }),
  );

  it.effect("rejects else outside a block", () =>
    Effect.gen(function* () {
      const error = yield* failure("A{{else}}B");

      expect(error.reason).toBe(PromptSyntaxErrorReason.UnexpectedElse);
    }),
  );

  it.effect("rejects a second else", () =>
    Effect.gen(function* () {
      const error = yield* failure("{{#if a}}A{{else}}B{{else}}C{{/if}}");

      expect(error.reason).toBe(PromptSyntaxErrorReason.DuplicateElse);
    }),
  );

  it.effect("rejects else if inside each", () =>
    Effect.gen(function* () {
      const error = yield* failure("{{#each xs as |x|}}A{{else if b}}B{{/each}}");

      expect(error.reason).toBe(PromptSyntaxErrorReason.UnexpectedElse);
    }),
  );

  it.effect("requires block params on each", () =>
    Effect.gen(function* () {
      const error = yield* failure("{{#each items}}{{this}}{{/each}}");

      expect(error.reason).toBe(PromptSyntaxErrorReason.InvalidBlockParams);
    }),
  );

  it.effect("rejects this", () =>
    Effect.gen(function* () {
      const error = yield* failure("{{this}}");

      expect(error.reason).toBe(PromptSyntaxErrorReason.InvalidExpression);
    }),
  );

  it.effect("rejects an unknown data variable", () =>
    Effect.gen(function* () {
      const error = yield* failure("{{#each xs as |x|}}{{@key}}{{/each}}");

      expect(error).toMatchObject({
        column: 22,
        reason: PromptSyntaxErrorReason.UnknownDataVariable,
      });
    }),
  );

  it.effect("rejects triple braces", () =>
    Effect.gen(function* () {
      const error = yield* failure("{{{name}}}");

      expect(error.reason).toBe(PromptSyntaxErrorReason.UnexpectedToken);
    }),
  );

  it.effect("rejects a tag with no closing braces", () =>
    Effect.gen(function* () {
      const error = yield* failure("Hello {{name\nand {{other}}");

      expect(error).toMatchObject({
        column: 7,
        line: 1,
        reason: PromptSyntaxErrorReason.UnterminatedTag,
      });
    }),
  );

  it.effect("rejects a comment with no end", () =>
    Effect.gen(function* () {
      const error = yield* failure("{{!-- open }}");

      expect(error.reason).toBe(PromptSyntaxErrorReason.UnterminatedComment);
    }),
  );

  it.effect("rejects a condition that is not a comparison", () =>
    Effect.gen(function* () {
      const error = yield* failure("{{#if a b}}x{{/if}}");

      expect(error.reason).toBe(PromptSyntaxErrorReason.InvalidCondition);
    }),
  );
});
