import { lookup, whenDefined } from "./object.ts";
import { Effect, Match, Predicate, Result } from "effect";
import {
  ComparisonOperators,
  DataVariables,
  identifierPattern,
  reservedWords,
  Roles,
} from "./ast.ts";
import type * as Ast from "./ast.ts";
import { didYouMean, locate, PromptSyntaxErrorReason as Reason, syntaxError } from "./errors.ts";
import type { PromptSyntaxError, SourceFile, SyntaxErrorReason } from "./errors.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { describeLexeme, lex, LexemeKinds, skipWhitespace, unescapeString } from "./lexer.ts";
import type { Lexeme } from "./lexer.ts";

type Parsed<A> = Result.Result<A, PromptSyntaxError>;

const Blocks = {
  each: "each",
  if: "if",
  unless: "unless",
} as const;

const Keywords = {
  as: "as",
  else: "else",
  if: "if",
  pipe: "|",
} as const;

const TokenKinds = {
  close: "close",
  else: "else",
  node: "node",
  open: "open",
  role: "role",
} as const;

interface EachParams {
  readonly iterable: Ast.ValueExpression;
  readonly item: string;
  readonly index?: string;
}

type Token =
  | { readonly kind: typeof TokenKinds.node; readonly node: Ast.Node }
  | {
      readonly kind: typeof TokenKinds.role;
      readonly role: Ast.Role;
      readonly closing: boolean;
      readonly span: Ast.Span;
    }
  | {
      readonly kind: typeof TokenKinds.open;
      readonly block: (typeof Blocks)[keyof typeof Blocks];
      readonly condition?: Ast.Condition;
      readonly each?: EachParams;
      readonly span: Ast.Span;
    }
  | {
      readonly kind: typeof TokenKinds.else;
      readonly condition?: Ast.Condition;
      readonly span: Ast.Span;
    }
  | { readonly kind: typeof TokenKinds.close; readonly name: string; readonly span: Ast.Span };

interface Located {
  readonly tagEnd: number;
  readonly stripRight: boolean;
  readonly token?: Token;
}

interface Cut {
  readonly at: number;
  readonly resume: number;
  readonly token: Token | undefined;
  readonly trimEnd: boolean;
}

interface RoleMatch {
  readonly index: number;
  readonly end: number;
  readonly role: Ast.Role;
  readonly closing: boolean;
  readonly escaped: boolean;
  readonly tag: string;
}

const FrameKinds = {
  ...Blocks,
  role: "role",
  root: "root",
} as const;
type FrameKind = (typeof FrameKinds)[keyof typeof FrameKinds];

interface Frame {
  readonly kind: FrameKind;
  readonly start: number;
  readonly body: Ast.Node[];
  nodes: Ast.Node[];
  readonly branches: {
    readonly condition: Ast.Condition;
    readonly start: number;
    readonly body: Ast.Node[];
  }[];
  alternate?: Ast.Node[];
  elseStart?: number;
  readonly role?: Ast.Role;
  readonly each?: EachParams;
}

const partialSourcePattern =
  /\s*(?:(?<quoted>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(?<bare>[^\s"'=]+))/uy;

const rolePattern = /\\?<(?<closing>\/?)(?<role>system|user|assistant)>/gu;

const doubleQuotedTagPattern = /"(?:[^"\\]|\\.)*"/suy;

const singleQuotedTagPattern = /'(?:[^'\\]|\\.)*'/suy;

const longCommentEndPattern = /--~?\}\}/gu;

const shortCommentEndPattern = /~?\}\}/gu;

const frontmatterOpenPattern = /^\uFEFF?---[ \t]*\r?\n/u;

const frontmatterClosePattern = /^---[ \t]*(?:\r?\n|$)/gmu;

const blankLinePattern = /^[ \t]*\r?$/u;

const indentPattern = /^[ \t]*$/u;

const wordLiterals: ReadonlyMap<string, Ast.LiteralValue> = new Map([
  ["false", false],
  ["null", null],
  ["true", true],
]);

const blockNames = Object.values(Blocks);

const toExpression = (file: SourceFile, lexeme: Lexeme): Parsed<Ast.Expression> => {
  const span = { end: lexeme.end, start: lexeme.start };
  if (lexeme.kind === LexemeKinds.string) {
    return Result.succeed({ _tag: "Literal", span, value: unescapeString(lexeme.text) });
  }
  if (lexeme.kind === LexemeKinds.number) {
    return Result.succeed({ _tag: "Literal", span, value: Number(lexeme.text) });
  }
  if (lexeme.kind === LexemeKinds.op) {
    return Result.fail(
      syntaxError(
        file,
        lexeme.start,
        Reason.UnexpectedToken,
        `Unexpected ${describeLexeme(lexeme)} in the tag.`,
      ),
    );
  }
  if (wordLiterals.has(lexeme.text)) {
    return Result.succeed({ _tag: "Literal", span, value: wordLiterals.get(lexeme.text) ?? null });
  }
  if (lexeme.text.startsWith("@")) {
    const name = lookup(DataVariables, lexeme.text.slice(1));
    return name === undefined
      ? Result.fail(
          syntaxError(
            file,
            lexeme.start,
            Reason.UnknownDataVariable,
            `Unknown data variable '${lexeme.text}'. Use '@index', '@first' or '@last'.`,
          ),
        )
      : Result.succeed({ _tag: "Data", name, span });
  }
  const [root = "", ...segments] = lexeme.text.split(".");
  if (reservedWords.has(root)) {
    return Result.fail(
      syntaxError(
        file,
        lexeme.start,
        Reason.InvalidExpression,
        root === "this"
          ? "'this' is not supported. Name the item with block params: '{{#each items as |item|}}'."
          : `'${root}' is a reserved word and cannot be a variable.`,
      ),
    );
  }
  return Result.succeed({ _tag: "Path", root, segments, span });
};

const toValue = (file: SourceFile, lexeme: Lexeme) =>
  Result.flatMap(toExpression(file, lexeme), (expression) =>
    Predicate.isTagged(expression, "Literal")
      ? Result.fail(
          syntaxError(
            file,
            lexeme.start,
            Reason.InvalidExpression,
            `Expected a variable but found ${describeLexeme(lexeme)}.`,
          ),
        )
      : Result.succeed(expression),
  );

const toIdentifier = (
  file: SourceFile,
  lexeme: Lexeme | undefined,
  what: string,
  fallback: number,
): Parsed<string> =>
  lexeme === undefined || reservedWords.has(lexeme.text) || !identifierPattern.test(lexeme.text)
    ? Result.fail(
        syntaxError(
          file,
          lexeme?.start ?? fallback,
          Reason.InvalidIdentifier,
          `Expected ${what} but found ${describeLexeme(lexeme)}.`,
        ),
      )
    : Result.succeed(lexeme.text);

const parseCondition = (
  file: SourceFile,
  lexemes: readonly Lexeme[],
  tag: Ast.Span,
  block: string,
) =>
  Result.gen(function* conditionProgram() {
    const [left, operator, right, ...rest] = lexemes;
    if (left === undefined) {
      return yield* Result.fail(
        syntaxError(file, tag.start, Reason.InvalidCondition, `'{{${block}}}' needs a condition.`),
      );
    }
    const value = yield* toValue(file, left);
    const span = { end: (lexemes.at(-1) ?? left).end, start: left.start };
    if (operator === undefined) {
      return { _tag: "Truthy" as const, span, value };
    }
    const comparison =
      operator.text === ComparisonOperators.equals ? ComparisonOperators.equals : undefined;
    const negated =
      operator.text === ComparisonOperators.notEquals ? ComparisonOperators.notEquals : undefined;
    const compared = right === undefined ? undefined : yield* toExpression(file, right);
    const operatorValue = comparison ?? negated;
    if (
      operatorValue === undefined ||
      compared === undefined ||
      !Predicate.isTagged(compared, "Literal") ||
      rest.length > 0
    ) {
      return yield* Result.fail(
        syntaxError(
          file,
          operator.start,
          Reason.InvalidCondition,
          "Write a condition as 'name', 'name == \"value\"' or 'name != \"value\"', and compare with a string, a number, true, false or null.",
        ),
      );
    }
    return {
      _tag: "Compare" as const,
      left: value,
      operator: operatorValue,
      right: compared,
      span,
    };
  });

const parseArguments = (file: SourceFile, lexemes: readonly Lexeme[]) =>
  Result.gen(function* argumentsProgram() {
    const args: Ast.Expression[] = [];
    const hash: Ast.HashArgument[] = [];
    for (let position = 0; position < lexemes.length; position += 1) {
      const lexeme = lexemes[position];
      const next = lexemes[position + 1];
      if (lexeme === undefined) {
        break;
      }
      if (next?.text === "=") {
        const name = yield* toIdentifier(file, lexeme, "an argument name", lexeme.start);
        const valueLexeme = lexemes[position + 2];
        if (valueLexeme === undefined) {
          return yield* Result.fail(
            syntaxError(
              file,
              next.end,
              Reason.InvalidExpression,
              `The argument '${name}' has no value.`,
            ),
          );
        }
        const value = yield* toExpression(file, valueLexeme);
        hash.push({ name, span: { end: valueLexeme.end, start: lexeme.start }, value });
        position += 2;
      } else if (hash.length > 0) {
        return yield* Result.fail(
          syntaxError(
            file,
            lexeme.start,
            Reason.InvalidExpression,
            "Put positional arguments before named arguments.",
          ),
        );
      } else {
        args.push(yield* toExpression(file, lexeme));
      }
    }
    return { args, hash };
  });

const makeFrame = (kind: FrameKind, start: number): Frame => {
  const body: Ast.Node[] = [];
  return { body, branches: [], kind, nodes: body, start };
};

const describeFrame = (frame: Frame) =>
  frame.kind === FrameKinds.role ? `<${frame.role ?? Roles.user}>` : `{{#${frame.kind}}}`;

export const parse = (text: string, options: { readonly path?: string } = {}) =>
  Effect.suspend(() =>
    Effect.fromResult(
      Result.gen(function* parseProgram() {
        const file: SourceFile = { text, ...whenDefined(options.path, (path) => ({ path })) };

        const opening = frontmatterOpenPattern.exec(text);
        frontmatterClosePattern.lastIndex = opening?.[0].length ?? 0;
        const closing = opening === null ? null : frontmatterClosePattern.exec(text);
        if (opening !== null && closing === null) {
          return yield* Result.fail(
            syntaxError(
              file,
              0,
              Reason.UnterminatedFrontmatter,
              "The frontmatter has no closing '---' line.",
            ),
          );
        }
        const frontmatter =
          opening === null || closing === null
            ? undefined
            : yield* parseFrontmatter(file, opening[0].length, closing.index);
        const byteOrderMarkLength = text.startsWith("\uFEFF") ? 1 : 0;
        const bodyStart =
          closing === null ? byteOrderMarkLength : closing.index + closing[0].length;

        const fail = (offset: number, reason: SyntaxErrorReason, detail: string) =>
          Result.fail(syntaxError(file, offset, reason, detail));

        const readEachParams = (lexemes: readonly Lexeme[], span: Ast.Span): Parsed<EachParams> =>
          Result.gen(function* eachParamsProgram() {
            const usage = "Write '{{#each items as |item|}}' or '{{#each items as |item index|}}'.";
            const [iterableLexeme, as, open, itemLexeme, ...rest] = lexemes;
            if (iterableLexeme === undefined) {
              return yield* fail(span.start, Reason.InvalidBlockParams, usage);
            }
            const iterable = yield* toValue(file, iterableLexeme);
            const hasParams =
              as?.text === Keywords.as &&
              open?.text === Keywords.pipe &&
              rest.at(-1)?.text === Keywords.pipe &&
              rest.length <= 2;
            if (!hasParams) {
              return yield* fail(
                (as ?? iterableLexeme).start,
                Reason.InvalidBlockParams,
                `'{{#each}}' needs block params. ${usage}`,
              );
            }
            const item = yield* toIdentifier(file, itemLexeme, "the item name", span.start);
            const [indexLexeme] = rest.length === 2 ? rest : [];
            if (indexLexeme === undefined) {
              return { item, iterable };
            }
            const index = yield* toIdentifier(file, indexLexeme, "the index name", span.start);
            return { index, item, iterable };
          });

        const readOpenBlock = (at: number, end: number, span: Ast.Span): Parsed<Token> =>
          Result.gen(function* openBlockProgram() {
            const [name, ...rest] = yield* lex(file, text, at, end, 0);
            const blockName = name?.text ?? "";
            if (blockName === Blocks.if || blockName === Blocks.unless) {
              const condition = yield* parseCondition(file, rest, span, `#${blockName}`);
              return { block: blockName, condition, kind: TokenKinds.open, span };
            }
            if (blockName === Blocks.each) {
              const each = yield* readEachParams(rest, span);
              return { block: Blocks.each, each, kind: TokenKinds.open, span };
            }
            return yield* fail(
              name?.start ?? at,
              Reason.UnknownBlock,
              `Unknown block '#${blockName}'. Use '#if', '#unless' or '#each'.${didYouMean(blockName, blockNames)}`,
            );
          });

        const readCloseBlock = (at: number, end: number, span: Ast.Span): Parsed<Token> =>
          Result.gen(function* closeBlockProgram() {
            const [name, ...rest] = yield* lex(file, text, at, end, 0);
            if (name?.kind !== LexemeKinds.word || rest.length > 0) {
              return yield* fail(
                span.start,
                Reason.UnexpectedToken,
                "A closing tag contains only the block name, for example '{{/if}}'.",
              );
            }
            return { kind: TokenKinds.close, name: name.text, span };
          });

        const readPartial = (at: number, end: number, span: Ast.Span): Parsed<Token> =>
          Result.gen(function* partialProgram() {
            partialSourcePattern.lastIndex = 0;
            const groups = partialSourcePattern.exec(text.slice(at, end))?.groups;
            if (groups === undefined) {
              return yield* fail(
                span.start,
                Reason.InvalidExpression,
                "A partial needs a path, for example '{{> ./contract.md}}'.",
              );
            }
            const source = groups["bare"] ?? unescapeString(groups["quoted"] ?? "''");
            const lexemes = yield* lex(file, text, at + partialSourcePattern.lastIndex, end, 0);
            const { args, hash } = yield* parseArguments(file, lexemes);
            const [extra] = args;
            if (extra !== undefined) {
              return yield* fail(
                extra.span.start,
                Reason.InvalidExpression,
                "A partial accepts only named arguments, for example '{{> ./item.md item=line}}'.",
              );
            }
            return {
              kind: TokenKinds.node,
              node: { _tag: "Partial" as const, hash, indent: "", source, span },
            };
          });

        const readExpression = (at: number, end: number, span: Ast.Span): Parsed<Token> =>
          Result.gen(function* expressionProgram() {
            const [head, ...rest] = yield* lex(file, text, at, end, 0);
            if (head === undefined) {
              return yield* fail(span.start, Reason.UnexpectedToken, "This tag is empty.");
            }
            if (head.text === Keywords.else) {
              const [ifWord, ...conditionLexemes] = rest;
              if (ifWord === undefined) {
                return { kind: TokenKinds.else, span };
              }
              if (ifWord.text !== Keywords.if) {
                return yield* fail(
                  ifWord.start,
                  Reason.UnexpectedToken,
                  "Write '{{else}}' or '{{else if condition}}'.",
                );
              }
              const condition = yield* parseCondition(file, conditionLexemes, span, "else if");
              return { condition, kind: TokenKinds.else, span };
            }
            if (rest.length === 0) {
              const value = yield* toValue(file, head);
              return { kind: TokenKinds.node, node: { _tag: "Output" as const, span, value } };
            }
            const name = yield* toIdentifier(file, head, "a helper name", head.start);
            const { args, hash } = yield* parseArguments(file, rest);
            return {
              kind: TokenKinds.node,
              node: { _tag: "Helper" as const, args, hash, name, span },
            };
          });

        const readTag = (start: number, end: number, span: Ast.Span): Parsed<Token> => {
          const at = skipWhitespace(text, start);
          const sigil = at < end ? text[at] : undefined;
          switch (sigil) {
            case undefined: {
              return fail(span.start, Reason.UnexpectedToken, "This tag is empty.");
            }
            case "#": {
              return readOpenBlock(at + 1, end, span);
            }
            case "/": {
              return readCloseBlock(at + 1, end, span);
            }
            case ">": {
              return readPartial(at + 1, end, span);
            }
            case "^": {
              return fail(
                at,
                Reason.UnexpectedToken,
                "Inverse sections are not supported. Use '{{else}}' or '{{#unless}}'.",
              );
            }
            default: {
              return readExpression(at, end, span);
            }
          }
        };

        const scan = (): Parsed<readonly Token[]> => {
          const escapes: number[] = [];
          const cuts: Cut[] = [];

          const readRole = (found: RoleMatch): Parsed<number> => {
            if (found.escaped) {
              escapes.push(found.index);
              return Result.succeed(found.end);
            }
            const lineEnd = text.indexOf("\n", found.end);
            const next = lineEnd === -1 ? text.length : lineEnd + 1;
            if (text.slice(found.end, next).trim().length > 0) {
              return fail(
                found.index,
                Reason.InvalidRoleTag,
                `The role tag '${found.tag}' must stand alone on its line. Move the text to the next line, or write '\\${found.tag}' to keep it as text.`,
              );
            }
            cuts.push({
              at: found.index,
              resume: next,
              token: {
                closing: found.closing,
                kind: TokenKinds.role,
                role: found.role,
                span: { end: found.end, start: found.index },
              },
              trimEnd: false,
            });
            return Result.succeed(next);
          };

          const locateComment = (tagStart: number, innerStart: number): Parsed<Located> => {
            const long = text.startsWith("!--", innerStart);
            const endPattern = long ? longCommentEndPattern : shortCommentEndPattern;
            endPattern.lastIndex = innerStart;
            const match = endPattern.exec(text);
            return match === null
              ? fail(
                  tagStart,
                  Reason.UnterminatedComment,
                  `This comment has no closing '${long ? "--}}" : "}}"}'.`,
                )
              : Result.succeed({
                  stripRight: match[0].includes("~"),
                  tagEnd: match.index + match[0].length,
                });
          };

          const locateTag = (tagStart: number, innerStart: number): Parsed<Located> =>
            Result.gen(function* locateTagProgram() {
              for (let index = innerStart; index < text.length - 1;) {
                const char = text[index];
                if (char === '"' || char === "'") {
                  const quotedPattern =
                    char === '"' ? doubleQuotedTagPattern : singleQuotedTagPattern;
                  quotedPattern.lastIndex = index;
                  index += quotedPattern.exec(text)?.[0].length ?? text.length;
                } else if (text.startsWith("{{", index)) {
                  break;
                } else if (text.startsWith("}}", index)) {
                  const stripRight = index > innerStart && text[index - 1] === "~";
                  const tagEnd = index + 2;
                  const token = yield* readTag(innerStart, stripRight ? index - 1 : index, {
                    end: tagEnd,
                    start: tagStart,
                  });
                  return { stripRight, tagEnd, token };
                } else {
                  index += char === "\\" ? 2 : 1;
                }
              }
              return yield* fail(tagStart, Reason.UnterminatedTag, "This tag has no closing '}}'.");
            });

          const standaloneLine = (
            tagStart: number,
            tagEnd: number,
          ):
            | { readonly start: number; readonly next: number; readonly indent: string }
            | undefined => {
            const lineStart = Math.max(text.lastIndexOf("\n", tagStart - 1) + 1, bodyStart);
            const lineEnd = text.indexOf("\n", tagEnd);
            const indent = text.slice(lineStart, tagStart);
            const rest = text.slice(tagEnd, lineEnd === -1 ? text.length : lineEnd);
            return indentPattern.test(indent) && blankLinePattern.test(rest)
              ? { indent, next: lineEnd === -1 ? text.length : lineEnd + 1, start: lineStart }
              : undefined;
          };

          const placeTag = (tagStart: number, stripLeft: boolean, located: Located) => {
            const { stripRight, tagEnd, token } = located;
            const partial =
              token?.kind === TokenKinds.node && Predicate.isTagged(token.node, "Partial")
                ? token.node
                : undefined;
            const inline = token?.kind === TokenKinds.node && partial === undefined;
            const standalone =
              stripLeft || stripRight || inline ? undefined : standaloneLine(tagStart, tagEnd);
            const resume = stripRight ? skipWhitespace(text, tagEnd) : (standalone?.next ?? tagEnd);
            cuts.push({
              at: standalone?.start ?? tagStart,
              resume,
              token:
                partial === undefined
                  ? token
                  : {
                      kind: TokenKinds.node,
                      node: { ...partial, indent: standalone?.indent ?? "" },
                    },
              trimEnd: stripLeft,
            });
            return resume;
          };

          const readTagAt = (tagStart: number): Parsed<number> =>
            Result.gen(function* tagAtProgram() {
              if (
                text[tagStart - 1] === "\\" &&
                tagStart - 1 >= (cuts.at(-1)?.resume ?? bodyStart)
              ) {
                escapes.push(tagStart - 1);
                return tagStart + 2;
              }
              if (text[tagStart + 2] === "{") {
                return yield* fail(
                  tagStart,
                  Reason.UnexpectedToken,
                  "Triple braces are not needed: effect-md never escapes output. Write '{{name}}'.",
                );
              }
              const stripLeft = text[tagStart + 2] === "~";
              const innerStart = tagStart + (stripLeft ? 3 : 2);
              const located = yield* text[innerStart] === "!"
                ? locateComment(tagStart, innerStart)
                : locateTag(tagStart, innerStart);
              return placeTag(tagStart, stripLeft, located);
            });

          rolePattern.lastIndex = bodyStart;
          const roles = [...text.matchAll(rolePattern)].flatMap((match): RoleMatch[] => {
            const role = lookup(Roles, match.groups?.["role"] ?? "");
            const atLineStart = match.index === bodyStart || text[match.index - 1] === "\n";
            if (role === undefined || !atLineStart) {
              return [];
            }
            const isClosing = match.groups?.["closing"] === "/";
            return [
              {
                closing: isClosing,
                end: match.index + match[0].length,
                escaped: match[0].startsWith("\\"),
                index: match.index,
                role,
                tag: `<${isClosing ? "/" : ""}${role}>`,
              },
            ];
          });
          for (let cursor = bodyStart; ;) {
            const role = roles.find((candidate) => candidate.index >= cursor);
            const tagStart = text.indexOf("{{", cursor);
            const found =
              role !== undefined && (tagStart === -1 || role.index < tagStart) ? role : undefined;
            if (found === undefined && tagStart === -1) {
              break;
            }
            const next = found === undefined ? readTagAt(tagStart) : readRole(found);
            if (Result.isFailure(next)) {
              return Result.fail(next.failure);
            }
            cursor = next.success;
          }
          const end: Cut = {
            at: text.length,
            resume: text.length,
            token: undefined,
            trimEnd: false,
          };
          return Result.succeed(
            [...cuts, end].flatMap((cut, index, all) => {
              const segmentStart = all[index - 1]?.resume ?? bodyStart;
              const dropped = escapes.filter(
                (backslash) => backslash >= segmentStart && backslash < cut.resume,
              );
              const starts = [segmentStart, ...dropped.map((backslash) => backslash + 1)];
              const start = starts.at(-1) ?? segmentStart;
              const sliceEnd = Math.max(cut.at, start);
              const joined = starts
                .map((from, part) => text.slice(from, dropped[part] ?? sliceEnd))
                .join("");
              const value = cut.trimEnd ? joined.trimEnd() : joined;
              const textTokens: Token[] =
                value.length > 0
                  ? [
                      {
                        kind: TokenKinds.node,
                        node: { _tag: "Text", span: { end: cut.at, start }, value },
                      },
                    ]
                  : [];
              return cut.token === undefined ? textTokens : [...textTokens, cut.token];
            }),
          );
        };

        const build = (scanned: readonly Token[]): Parsed<Ast.Body> => {
          const root = makeFrame(FrameKinds.root, bodyStart);
          const stack: Frame[] = [root];
          const messages: Ast.Message[] = [];
          const current = () => stack.at(-1) ?? root;
          const isBlock = (frame: Frame) =>
            frame.kind !== FrameKinds.root && frame.kind !== FrameKinds.role;

          const onOpen = (token: Extract<Token, { readonly kind: typeof TokenKinds.open }>) => {
            const frame: Frame = {
              ...makeFrame(token.block, token.span.start),
              ...whenDefined(token.each, (each) => ({ each })),
            };
            if (token.condition !== undefined) {
              frame.branches.push({
                body: frame.body,
                condition:
                  token.block === Blocks.unless
                    ? { _tag: "Not", condition: token.condition, span: token.condition.span }
                    : token.condition,
                start: token.span.start,
              });
            }
            stack.push(frame);
          };

          const onElse = (
            token: Extract<Token, { readonly kind: typeof TokenKinds.else }>,
          ): PromptSyntaxError | null => {
            const top = current();
            if (!isBlock(top)) {
              return syntaxError(
                file,
                token.span.start,
                Reason.UnexpectedElse,
                "'{{else}}' must be inside '{{#if}}', '{{#unless}}' or '{{#each}}'.",
              );
            }
            if (top.alternate !== undefined) {
              return syntaxError(
                file,
                token.span.start,
                Reason.DuplicateElse,
                `${describeFrame(top)} already has an '{{else}}'. Put '{{else if}}' branches before it.`,
              );
            }
            if (token.condition === undefined) {
              top.alternate = [];
              top.elseStart = token.span.start;
              top.nodes = top.alternate;
              return null;
            }
            if (top.kind === FrameKinds.each) {
              return syntaxError(
                file,
                token.span.start,
                Reason.UnexpectedElse,
                "'{{else if}}' is not allowed in '{{#each}}'. Use '{{else}}' for the empty case.",
              );
            }
            const body: Ast.Node[] = [];
            top.branches.push({ body, condition: token.condition, start: token.span.start });
            top.nodes = body;
            return null;
          };

          const onClose = (
            token: Extract<Token, { readonly kind: typeof TokenKinds.close }>,
          ): PromptSyntaxError | null => {
            const top = current();
            if (!isBlock(top)) {
              return syntaxError(
                file,
                token.span.start,
                Reason.UnexpectedClose,
                `'{{/${token.name}}}' has no matching '{{#${token.name}}}'.`,
              );
            }
            if (top.kind !== token.name) {
              return syntaxError(
                file,
                token.span.start,
                Reason.MismatchedClose,
                `Expected '{{/${top.kind}}}' to close ${describeFrame(top)} from line ${locate(text, top.start).line}, but found '{{/${token.name}}}'.`,
              );
            }
            stack.pop();
            const span = { end: token.span.end, start: top.start };
            const alternate = top.alternate ?? [];
            if (top.each !== undefined) {
              current().nodes.push({ _tag: "Each", alternate, body: top.body, ...top.each, span });
              return null;
            }
            const [first, ...rest] = top.branches.map((branch, index) => ({
              body: branch.body,
              condition: branch.condition,
              span: {
                end: top.branches[index + 1]?.start ?? top.elseStart ?? token.span.start,
                start: branch.start,
              },
            }));
            if (first !== undefined) {
              current().nodes.push({ _tag: "If", alternate, branches: [first, ...rest], span });
            }
            return null;
          };

          const onRole = (
            token: Extract<Token, { readonly kind: typeof TokenKinds.role }>,
          ): PromptSyntaxError | null => {
            const top = current();
            const tag = `<${token.closing ? "/" : ""}${token.role}>`;
            if (isBlock(top)) {
              return syntaxError(
                file,
                token.span.start,
                token.closing ? Reason.UnclosedBlock : Reason.RoleInsideBlock,
                token.closing
                  ? `Close ${describeFrame(top)} before '${tag}'.`
                  : `A role tag cannot be inside ${describeFrame(top)}. Put the block inside the role.`,
              );
            }
            if (!token.closing && top.kind === FrameKinds.role) {
              return syntaxError(
                file,
                token.span.start,
                Reason.UnclosedRole,
                `Close ${describeFrame(top)} before you open '${tag}'.`,
              );
            }
            if (!token.closing) {
              stack.push({ ...makeFrame(FrameKinds.role, token.span.start), role: token.role });
              return null;
            }
            if (top.role !== token.role) {
              return syntaxError(
                file,
                token.span.start,
                Reason.UnexpectedClose,
                `'${tag}' has no matching '<${token.role}>'.`,
              );
            }
            stack.pop();
            messages.push({
              body: top.body,
              role: token.role,
              span: { end: token.span.end, start: top.start },
            });
            return null;
          };

          for (const token of scanned) {
            const error = Match.value(token).pipe(
              Match.discriminatorsExhaustive("kind")({
                close: onClose,
                else: onElse,
                node: ({ node }) => {
                  current().nodes.push(node);
                  return null;
                },
                open: (opened) => {
                  onOpen(opened);
                  return null;
                },
                role: onRole,
              }),
            );
            if (error !== null) {
              return Result.fail(error);
            }
          }

          const open = current();
          if (open !== root) {
            const closingTag =
              open.kind === FrameKinds.role ? `</${open.role ?? Roles.user}>` : `{{/${open.kind}}}`;
            return fail(
              open.start,
              open.kind === FrameKinds.role ? Reason.UnclosedRole : Reason.UnclosedBlock,
              `${describeFrame(open)} has no closing '${closingTag}'.`,
            );
          }
          if (!scanned.some((token) => token.kind === TokenKinds.role)) {
            return Result.succeed({ _tag: "Fragment", nodes: root.body });
          }
          const stray = root.body.find(
            (node) => !Predicate.isTagged(node, "Text") || node.value.trim().length > 0,
          );
          return stray === undefined
            ? Result.succeed({ _tag: "Messages", messages })
            : fail(
                stray.span.start,
                Reason.TextOutsideRole,
                "This file uses role tags, so every text and tag must be inside '<system>', '<user>' or '<assistant>'.",
              );
        };

        const body = yield* build(yield* scan());
        const document: Ast.PromptDocument = {
          body,
          ...whenDefined(frontmatter, (value) => ({ frontmatter: value })),
          ...whenDefined(options.path, (path) => ({ path })),
        };
        return document;
      }),
    ),
  );
