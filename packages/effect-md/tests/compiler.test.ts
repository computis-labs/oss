import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { PromptCompileErrorReason } from "../src/compile-error.ts";
import { compile } from "../src/compiler.ts";
import { prompts } from "./fixtures/prompts/prompts.gen.ts";

const failure = (sources: readonly { readonly path: string; readonly text: string }[]) =>
  Effect.flip(compile(sources));

describe("compiled prompts", () => {
  it("builds a static prompt once and returns the same value on each call", () => {
    const prompt = prompts.hello.make();

    expect(prompt.content).toMatchObject([
      { content: "Be short.", role: "system" },
      { content: [{ text: "Hi!", type: "text" }], role: "user" },
    ]);
    expect(prompts.hello.make()).toBe(prompt);
  });

  it("renders conditions, partials and untrusted text", () => {
    const prompt = prompts.invoice.extract.make({ source: "text", text: "Total ``` 10 EUR" });

    expect(prompt.content).toMatchObject([
      { content: "Sei un contabile. Rispondi solo in JSON.", role: "system" },
      {
        content: [{ text: "Il testo del PDF:\n````\nTotal ``` 10 EUR\n````", type: "text" }],
        role: "user",
      },
    ]);
  });

  it("puts an attached file between the text parts of the user message", () => {
    const prompt = prompts.invoice.extract.make({
      pdf: { data: "AAAA", fileName: "invoice.pdf", mediaType: "application/pdf" },
      source: "file",
    });

    expect(prompt.content[1]).toMatchObject({
      content: [
        { text: "Il PDF allegato:", type: "text" },
        { fileName: "invoice.pdf", mediaType: "application/pdf", type: "file" },
      ],
      role: "user",
    });
  });

  it("loops with data variables and renders the empty case", () => {
    const filled = prompts.lines.make({
      lines: [{ amount: 12.5, description: "Hosting" }, { description: "Support" }],
    });
    const empty = prompts.lines.make({ lines: [] });

    expect(filled.content).toMatchObject([
      { content: [{ text: "0. Hosting (12.5),\n1. Support" }] },
    ]);
    expect(empty.content).toMatchObject([{ content: [{ text: "No lines." }] }]);
  });

  it("passes named arguments to a partial and indents its lines", () => {
    const prompt = prompts.list.make({ items: ["a", "b"] });

    expect(prompt.content).toMatchObject([
      { content: [{ text: "Items:\n  - a\n    (checked)\n  - b\n    (checked)" }] },
    ]);
  });

  it("uses a schema from a TypeScript module as the input", () => {
    const prompt = prompts.greet.make({ count: 3, name: "Chiara", nickname: "Chia" });

    expect(prompt.content).toMatchObject([
      { content: [{ text: "Hello Chiara (Chia), you have 3 messages." }] },
    ]);
  });

  it("narrows optional and nullable values and prints JSON", () => {
    const withNote = prompts.notes.make({ data: { a: [1] }, note: "Call back", status: "open" });
    const withoutNote = prompts.notes.make({ data: null, status: null });

    expect(withNote.content).toMatchObject([
      { content: [{ text: 'Note: Call back\nStatus: open\nStill open.\nData: {"a":[1]}' }] },
    ]);
    expect(withoutNote.content).toMatchObject([{ content: [{ text: "No note.\nData: null" }] }]);
  });

  it("keeps a long prompt correct when it splits the render function", () => {
    const prompt = prompts.flags.make({ flag1: true, flag16: true, flag2: false, flag9: true });

    expect(prompt.content).toMatchObject([
      { content: [{ text: "1\n\n\n\n\n\n\n\n9\n\n\n\n\n\n\n16" }] },
    ]);
  });

  it("checks the falsy values of a literal type in a condition", () => {
    const off = prompts.toggles.make({ enabled: false, level: 0, mode: false });
    const on = prompts.toggles.make({ enabled: true, level: 2, mode: "auto" });

    expect(off.content).toMatchObject([{ content: [{ text: "off\n\nhidden\nmanual" }] }]);
    expect(on.content).toMatchObject([{ content: [{ text: "on\nlevel 2\nhidden\nmode auto" }] }]);
  });

  it.effect("decodes the encoded input before it renders", () =>
    Effect.gen(function* () {
      const prompt = yield* prompts.greet.decode({ count: 1, name: "Anna" });

      expect(prompt.content).toMatchObject([
        { content: [{ text: "Hello Anna, you have 1 messages." }] },
      ]);
    }),
  );
});

describe("compile errors", () => {
  describe("variables", () => {
    it.effect("points at an unknown variable and suggests a declared one", () =>
      Effect.gen(function* () {
        const error = yield* failure([
          { path: "a.prompt.md", text: "---\ninput:\n  customer: String\n---\nHi {{custmer}}\n" },
        ]);

        expect(error).toMatchObject({
          column: 6,
          line: 5,
          path: "a.prompt.md",
          reason: PromptCompileErrorReason.UnknownVariable,
        });
        expect(error.message).toContain("Did you mean 'customer'?");
      }),
    );

    it.effect("requires a check before it prints an optional value", () =>
      Effect.gen(function* () {
        const error = yield* failure([
          { path: "a.prompt.md", text: "---\ninput:\n  note?: String\n---\n{{note}}\n" },
        ]);

        expect(error.reason).toBe(PromptCompileErrorReason.MissingValue);
        expect(error.message).toContain("'{{#if note}}'");
      }),
    );

    it.effect("rejects a struct in an output tag and names the json helper", () =>
      Effect.gen(function* () {
        const error = yield* failure([
          {
            path: "a.prompt.md",
            text: "---\ninput:\n  customer:\n    name: String\n---\n{{customer}}\n",
          },
        ]);

        expect(error.reason).toBe(PromptCompileErrorReason.InvalidOutput);
        expect(error.message).toContain("{{json value}}");
      }),
    );

    it.effect("rejects an unknown field of a struct", () =>
      Effect.gen(function* () {
        const error = yield* failure([
          {
            path: "a.prompt.md",
            text: "---\ninput:\n  customer:\n    name: String\n---\n{{customer.nme}}\n",
          },
        ]);

        expect(error.reason).toBe(PromptCompileErrorReason.UnknownField);
        expect(error.message).toContain("Did you mean 'name'?");
      }),
    );

    it.effect("rejects a comparison with a value that the literal type never has", () =>
      Effect.gen(function* () {
        const error = yield* failure([
          {
            path: "a.prompt.md",
            text: '---\ninput:\n  source: Literal("file", "text")\n---\n{{#if source == "email"}}x{{/if}}\n',
          },
        ]);

        expect(error.reason).toBe(PromptCompileErrorReason.LiteralMismatch);
      }),
    );

    it.effect("rejects a data variable outside each", () =>
      Effect.gen(function* () {
        const error = yield* failure([{ path: "a.prompt.md", text: "{{@index}}" }]);

        expect(error.reason).toBe(PromptCompileErrorReason.UnknownVariable);
      }),
    );

    it.effect("rejects each over a value that is not an array", () =>
      Effect.gen(function* () {
        const error = yield* failure([
          {
            path: "a.prompt.md",
            text: "---\ninput:\n  name: String\n---\n{{#each name as |c|}}{{c}}{{/each}}\n",
          },
        ]);

        expect(error.reason).toBe(PromptCompileErrorReason.InvalidIterable);
      }),
    );
  });

  describe("conditions", () => {
    it.effect("rejects a condition that is always true", () =>
      Effect.gen(function* () {
        const error = yield* failure([
          {
            path: "a.prompt.md",
            text: "---\ninput:\n  customer:\n    name: String\n---\n{{#if customer}}x{{/if}}\n",
          },
        ]);

        expect(error.reason).toBe(PromptCompileErrorReason.ConstantCondition);
      }),
    );

    it.effect("rejects a comparison with a literal of another type", () =>
      Effect.gen(function* () {
        const error = yield* failure([
          {
            path: "a.prompt.md",
            text: '---\ninput:\n  count: Number\n---\n{{#if count == "3"}}x{{/if}}\n',
          },
        ]);

        expect(error).toMatchObject({
          column: 16,
          line: 5,
          reason: PromptCompileErrorReason.LiteralMismatch,
        });
        expect(error.message).toContain(`'count' is a Number, so it is never "3".`);
      }),
    );

    it.effect("rejects a comparison of an array with a literal", () =>
      Effect.gen(function* () {
        const error = yield* failure([
          {
            path: "a.prompt.md",
            text: '---\ninput:\n  tags: Array(String)\n---\n{{#if tags != "a"}}x{{/if}}\n',
          },
        ]);

        expect(error.reason).toBe(PromptCompileErrorReason.LiteralMismatch);
      }),
    );

    it.effect("rejects a null check on a value that is never null", () =>
      Effect.gen(function* () {
        const error = yield* failure([
          {
            path: "a.prompt.md",
            text: "---\ninput:\n  name: String\n---\n{{#if name == null}}x{{/if}}\n",
          },
        ]);

        expect(error.reason).toBe(PromptCompileErrorReason.ConstantCondition);
      }),
    );
  });

  describe("helpers and partials", () => {
    it.effect("rejects a file in a system message", () =>
      Effect.gen(function* () {
        const error = yield* failure([
          {
            path: "a.prompt.md",
            text: "---\ninput:\n  pdf: File\n---\n<system>\n{{file pdf}}\n</system>\n",
          },
        ]);

        expect(error.reason).toBe(PromptCompileErrorReason.FileNotAllowed);
      }),
    );

    it.effect("suggests the closest helper name", () =>
      Effect.gen(function* () {
        const error = yield* failure([
          { path: "a.prompt.md", text: "---\ninput:\n  text: String\n---\n{{untrustd text}}\n" },
        ]);

        expect(error.reason).toBe(PromptCompileErrorReason.UnknownHelper);
        expect(error.message).toContain("Did you mean 'untrusted'?");
      }),
    );

    it.effect("reports a missing partial with the path it looked for", () =>
      Effect.gen(function* () {
        const error = yield* failure([
          { path: "invoice/a.prompt.md", text: "{{> ./contrat.md}}" },
          { path: "invoice/contract.md", text: "x" },
        ]);

        expect(error.reason).toBe(PromptCompileErrorReason.MissingPartial);
        expect(error.message).toContain("invoice/contrat.md");
        expect(error.message).toContain("Did you mean 'invoice/contract.md'?");
      }),
    );

    it.effect("reports partials that include each other", () =>
      Effect.gen(function* () {
        const error = yield* failure([
          { path: "a.prompt.md", text: "{{> ./b.md}}" },
          { path: "b.md", text: "{{> ./c.md}}" },
          { path: "c.md", text: "{{> ./b.md}}" },
        ]);

        expect(error).toMatchObject({
          path: "c.md",
          reason: PromptCompileErrorReason.CyclicPartial,
        });
        expect(error.message).toContain("a.prompt.md → b.md → c.md → b.md");
      }),
    );

    it.effect("reports a variable that a partial declares but does not get", () =>
      Effect.gen(function* () {
        const error = yield* failure([
          { path: "a.prompt.md", text: "{{> ./item.md}}" },
          { path: "item.md", text: "---\ninput:\n  value: String\n---\n{{value}}" },
        ]);

        expect(error.reason).toBe(PromptCompileErrorReason.MissingPartialInput);
      }),
    );

    it.effect("reports an error inside a partial at the position in the partial", () =>
      Effect.gen(function* () {
        const error = yield* failure([
          { path: "a.prompt.md", text: "Intro\n{{> ./item.md}}" },
          { path: "item.md", text: "Line\n  {{unknown}}" },
        ]);

        expect(error).toMatchObject({
          column: 5,
          line: 2,
          path: "item.md",
          reason: PromptCompileErrorReason.UnknownVariable,
        });
      }),
    );

    it.effect("rejects two prompts with the same name", () =>
      Effect.gen(function* () {
        const error = yield* failure([
          { path: "invoice.prompt.md", text: "a" },
          { path: "invoice/extract.prompt.md", text: "b" },
        ]);

        expect(error.reason).toBe(PromptCompileErrorReason.DuplicatePromptName);
      }),
    );
  });
});
