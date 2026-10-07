import { whenDefined } from "./object.ts";
import { Array as Arr, Effect, Predicate, Schema } from "effect";
import { Prompt } from "effect/ai";

export const File = Schema.Struct({
  data: Schema.Union([Schema.String, Schema.Uint8Array, Schema.URL]),
  fileName: Schema.optionalKey(Schema.String),
  mediaType: Schema.String,
});

export type Part = string | Prompt.FilePart;

export type Value =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly Value[]
  | { readonly [key: string]: Value };

export class PromptInputError extends Schema.TaggedError<PromptInputError>()("PromptInputError", {
  detail: Schema.String,
  prompt: Schema.String,
}) {
  override get message() {
    return `Invalid input for the prompt '${this.prompt}': ${this.detail}`;
  }
}

const backtickRunPattern = /`+/gu;

const lineStartPattern = /^(?=.)/gmu;

export const show: (value: string | number | boolean) => string = String;

export const isFilled = (value: Value) => {
  if (value === null || value === undefined) {
    return false;
  }
  if (Predicate.isString(value)) {
    return value.length > 0;
  }
  if (Predicate.isNumber(value)) {
    return value !== 0;
  }
  if (Predicate.isBoolean(value)) {
    return value;
  }
  return !Array.isArray(value) || value.length > 0;
};

export const untrusted = (text: string, lang = "") => {
  const longest = Arr.reduce(text.matchAll(backtickRunPattern), 0, (max, match) =>
    Math.max(max, match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${text}\n${fence}`;
};

export const json = (value: Value, indent = 2) => JSON.stringify(value, null, indent) ?? "null";

export const indent = (text: string, prefix: string) => text.replaceAll(lineStartPattern, prefix);

export const file = (value: typeof File.Type) =>
  Prompt.filePart({
    data: value.data,
    mediaType: value.mediaType,
    ...whenDefined(value.fileName, (fileName) => ({ fileName })),
  });

const toContent = (parts: readonly Part[]) => {
  const content: (Prompt.TextPart | Prompt.FilePart)[] = [];
  for (const part of parts) {
    if (Predicate.isString(part)) {
      const text = part.trim();
      if (text.length > 0) {
        content.push(Prompt.textPart({ text }));
      }
    } else {
      content.push(part);
    }
  }
  return content;
};

export const system = (text: string) => Prompt.systemMessage({ content: text.trim() });

export const user = (parts: readonly Part[]) => Prompt.userMessage({ content: toContent(parts) });

export const assistant = (parts: readonly Part[]) =>
  Prompt.assistantMessage({ content: toContent(parts) });

export const definePrompt = <S extends Schema.Top>(definition: {
  readonly name: string;
  readonly description?: string;
  readonly input: S;
  readonly render: (input: S["Type"]) => Prompt.Prompt;
}) => {
  const decodeInput = Schema.decodeEffect(definition.input);
  return {
    Input: definition.input,
    decode: (input: S["Encoded"]) =>
      decodeInput(input).pipe(
        Effect.mapError((schemaError) =>
          PromptInputError.make({ detail: schemaError.message, prompt: definition.name }),
        ),
        Effect.map(definition.render),
      ),
    ...whenDefined(definition.description, (description) => ({ description })),
    make: definition.render,
    name: definition.name,
  };
};
