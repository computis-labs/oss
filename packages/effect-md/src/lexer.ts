import { Result } from "effect";
import { PromptSyntaxErrorReason as Reason, syntaxError } from "./errors.ts";
import type { PromptSyntaxError, SourceFile } from "./errors.ts";

export const LexemeKinds = {
  number: "number",
  op: "op",
  string: "string",
  word: "word",
} as const;

export interface Lexeme {
  readonly kind: (typeof LexemeKinds)[keyof typeof LexemeKinds];
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

const lexemePattern =
  /(?<word>@?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)|(?<string>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(?<number>-?\d+(?:\.\d+)?)|(?<op>==|!=|[=|(),])/uy;

const whitespacePattern = /\s*/uy;

const lexemeKinds = Object.values(LexemeKinds);

export const skipWhitespace = (source: string, from: number) => {
  whitespacePattern.lastIndex = from;
  return from + (whitespacePattern.exec(source)?.[0].length ?? 0);
};

export const unescapeString = (quoted: string) =>
  quoted.slice(1, -1).replaceAll(/\\(?<char>.)/gu, "$<char>");

export const describeLexeme = (lexeme: Lexeme | undefined) =>
  lexeme === undefined ? "nothing" : `'${lexeme.text}'`;

export const lex = (
  file: SourceFile,
  source: string,
  start: number,
  end: number,
  base: number,
): Result.Result<readonly Lexeme[], PromptSyntaxError> => {
  const lexemes: Lexeme[] = [];
  for (
    let cursor = skipWhitespace(source, start);
    cursor < end;
    cursor = skipWhitespace(source, cursor)
  ) {
    lexemePattern.lastIndex = cursor;
    const groups = lexemePattern.exec(source)?.groups;
    const kind = lexemeKinds.find((candidate) => groups?.[candidate] !== undefined);
    if (kind === undefined || lexemePattern.lastIndex > end) {
      const char = source[cursor] ?? "";
      const unterminated = char === '"' || char === "'";
      return Result.fail(
        syntaxError(
          file,
          base + cursor,
          unterminated ? Reason.UnterminatedString : Reason.UnexpectedToken,
          unterminated ? "This string has no closing quote." : `Unexpected character '${char}'.`,
        ),
      );
    }
    lexemes.push({
      end: base + lexemePattern.lastIndex,
      kind,
      start: base + cursor,
      text: source.slice(cursor, lexemePattern.lastIndex),
    });
    cursor = lexemePattern.lastIndex;
  }
  return Result.succeed(lexemes);
};
