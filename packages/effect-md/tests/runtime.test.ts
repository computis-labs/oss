import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Prompt } from "effect/ai";
import { definePrompt, indent, json, untrusted, user } from "../src/runtime.ts";

describe("untrusted", () => {
  it("wraps text in a fence that is longer than any backtick run inside it", () => {
    expect(untrusted("see ```code``` and ````more````")).toBe(
      "`````\nsee ```code``` and ````more````\n`````",
    );
  });

  it("uses a three backtick fence with the language when the text has no backticks", () => {
    expect(untrusted("<xml/>", "xml")).toBe("```xml\n<xml/>\n```");
  });
});

describe("json", () => {
  it("prints values with two spaces unless it gets another indent", () => {
    expect(json({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(json({ a: 1 }, 0)).toBe('{"a":1}');
  });
});

describe("indent", () => {
  it("indents every line that has content", () => {
    expect(indent("a\n\nb\n", "  ")).toBe("  a\n\n  b\n");
  });
});

describe("user", () => {
  it("trims each text part and drops empty ones", () => {
    const file = Prompt.filePart({ data: "AAAA", mediaType: "application/pdf" });

    const message = user(["\n  Read this:\n", file, "\n"]);

    expect(message.content).toMatchObject([
      { text: "Read this:", type: "text" },
      { mediaType: "application/pdf", type: "file" },
    ]);
  });
});

describe("definePrompt", () => {
  const greeting = definePrompt({
    input: Schema.Struct({ name: Schema.NonEmptyString }),
    name: "greeting",
    render: (input) => Prompt.fromMessages([user([`Hello ${input.name}`])]),
  });

  it.effect("decodes the input before it renders the prompt", () =>
    Effect.gen(function* () {
      const prompt = yield* greeting.decode({ name: "Laura" });

      expect(prompt.content).toMatchObject([{ content: [{ text: "Hello Laura" }], role: "user" }]);
    }),
  );

  it.effect("fails with a PromptInputError that names the prompt", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(greeting.decode({ name: "" }));

      expect(error).toMatchObject({ _tag: "PromptInputError", prompt: "greeting" });
      expect(error.message).toContain("Invalid input for the prompt 'greeting'");
    }),
  );
});
