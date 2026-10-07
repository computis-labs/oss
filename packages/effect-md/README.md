# @computis/effect-md

Write LLM prompts as Markdown files and use them as typed Effect AI prompts.

- A `.prompt.md` file is one prompt. A `.partial.md` file is a piece that prompts include.
- The frontmatter declares the input. The compiler checks every variable at build time and reports `file:line:column` errors.
- One generated module, `prompts.gen.ts`, exports every prompt. Each prompt has `make(input)` (no runtime check), `decode(input)` (Schema check) and `Input` (the Schema).
- The result is a `Prompt.Prompt` from `effect/ai`, ready for `LanguageModel.generateText` or `generateObject`.

## Install

```sh
npm install @computis/effect-md effect @effect/platform-node
```

It needs Effect 4 and Node 22 or later. The package is ESM only.

## Example

`src/prompts/invoice/extract.prompt.md`:

```md
---
description: Extract a foreign invoice
input:
  source: Literal("file", "text")
  text?: String
  pdf?: File
---

<system>
Sei un contabile. {{> ../shared/contract.partial.md}}
</system>

<user>
{{#if source == "text"}}
{{#if text}}
{{untrusted text}}
{{/if}}
{{else if pdf}}
{{file pdf}}
{{/if}}
</user>
```

```ts
import { Effect } from "effect";
import { prompts } from "./prompts/prompts.gen.ts";

const prompt = prompts.invoice.extract.make({ source: "text", text: "Invoice 42, total 100 EUR" });

const fromRequest = (body: unknown) =>
  Effect.gen(function* () {
    return yield* prompts.invoice.extract.decode(body);
  });
```

The prompt name comes from the path: `invoice/extract.prompt.md` is `prompts.invoice.extract`, and `line-items.prompt.md` is `prompts.lineItems`.

## Frontmatter

| Key           | Value                                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `description` | A string. It is kept on the generated prompt.                                                                                    |
| `input`       | A map of field names to types. Put `?` after a name to make the field optional.                                                  |
| `schema`      | `<module>#<Export>`: use a Schema from a TypeScript module instead of `input`. A relative module is relative to the prompt file. |

Types for `input`:

| Type                                  | Schema                                                            |
| ------------------------------------- | ----------------------------------------------------------------- |
| `String`, `Number`, `Boolean`         | `Schema.String`, `Schema.Number`, `Schema.Boolean`                |
| `Json`                                | `Schema.Json`, print it with `{{json value}}`                     |
| `File`                                | `{ data, mediaType, fileName? }`, attach it with `{{file value}}` |
| `Literal("a", "b")`                   | `Schema.Literals(["a", "b"])`                                     |
| `Array(T)` or `[T]`                   | `Schema.Array(T)`                                                 |
| `NullOr(T)`                           | `Schema.NullOr(T)`                                                |
| a nested map, or `[{ name: String }]` | `Schema.Struct(...)`                                              |

## Body

| Syntax                                                | Result                                                                                         |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `{{name}}`, `{{customer.name}}`                       | The value. Only strings, numbers, booleans and literals can be printed.                        |
| `{{untrusted text}}`, `{{untrusted text lang="xml"}}` | The text in a code fence that is longer than any backtick run in the text.                     |
| `{{json value}}`, `{{json value indent=0}}`           | The value as JSON.                                                                             |
| `{{file pdf}}`                                        | A file part in a user or assistant message.                                                    |
| `{{#if a}}…{{else if b == "x"}}…{{else}}…{{/if}}`     | A condition. Compare with `==` or `!=` and a literal.                                          |
| `{{#unless a}}…{{/unless}}`                           | A negated condition.                                                                           |
| `{{#each items as \|item i\|}}…{{else}}…{{/each}}`    | A loop, with `@index`, `@first` and `@last`. `{{else}}` is the empty case.                     |
| `{{> ./rules.partial.md name=value}}`                 | A partial. An indented partial on its own line keeps the indent on each line.                  |
| `{{! note }}`, `{{!-- note --}}`                      | A comment.                                                                                     |
| `{{~name~}}`                                          | Removes the whitespace next to the tag.                                                        |
| `\{{name}}`                                           | The text `{{name}}`.                                                                           |
| `<system>`, `<user>`, `<assistant>`                   | A message. The tag must stand alone on its line. A file with no role tags is one user message. |

A block tag that stands alone on its line removes the line. An optional or nullable value must be checked with `{{#if}}` before it is used.

## CLI

```sh
effect-md generate --root src/prompts --format "oxfmt --stdin-filepath={file}"
effect-md check    --root src/prompts --format "oxfmt --stdin-filepath={file}"
effect-md watch    --root src/prompts --format "oxfmt --stdin-filepath={file}"
```

| Flag        | Meaning                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| `--root`    | The folder with the prompt files. `prompts.gen.ts` goes in this folder.                                      |
| `--format`  | A command that reads the code on stdin and writes the formatted code on stdout. `{file}` is the output path. |
| `--runtime` | The import specifier of the runtime. The default is `@computis/effect-md/runtime`.                           |

`check` fails when `prompts.gen.ts` is missing or out of date. `watch` generates the file again on each change and keeps running after an error.

## Generated file

`prompts.gen.ts` is derived from the prompt files. Either commit it and run `check` in CI, or ignore it in git and run `generate` before every step that imports it, such as `build`, `test` and `typecheck`.
