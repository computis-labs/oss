import { lookup, whenDefined } from "./object.ts";
import { Predicate, Result, Schema } from "effect";
import { isAlias, isMap, isScalar, isSeq, parseDocument, Scalar } from "yaml";
import type { Pair, ParsedNode } from "yaml";
import { identifierPattern, PrimitiveTypes, reservedWords } from "./ast.ts";
import type { Field, Frontmatter, InputSpec, LiteralType, TypeNode } from "./ast.ts";
import { didYouMean, PromptSyntaxErrorReason as Reason, syntaxError } from "./errors.ts";
import type { PromptSyntaxError, SourceFile } from "./errors.ts";
import { describeLexeme, lex, LexemeKinds, unescapeString } from "./lexer.ts";
import type { Lexeme } from "./lexer.ts";

type Parsed<A> = Result.Result<A, PromptSyntaxError>;

const FrontmatterKeys = {
  description: "description",
  input: "input",
  schema: "schema",
} as const;

const TypeConstructors = {
  Array: "Array",
  Literal: "Literal",
  NullOr: "NullOr",
} as const;

const typeHints = {
  Struct: "Write a struct as a nested YAML map, and an array of structs as '[{ name: String }]'.",
  optional:
    "'optional' is not a type. Put '?' after the field name instead, for example 'text?: String'.",
};

const typeNames = [...Object.values(PrimitiveTypes), ...Object.values(TypeConstructors)];

const booleanWords: ReadonlyMap<string, boolean> = new Map([
  ["false", false],
  ["true", true],
]);

const quotedScalarTypes: ReadonlySet<string | undefined> = new Set([
  Scalar.QUOTE_DOUBLE,
  Scalar.QUOTE_SINGLE,
]);

const isString = Schema.is(Schema.String);

const scalarText = (node: ParsedNode | null) =>
  node !== null && isScalar(node) && isString(node.value) ? node.value : undefined;

const contentOffset = (node: ParsedNode, base: number) =>
  base + node.range[0] + (isScalar(node) && quotedScalarTypes.has(node.type) ? 1 : 0);

const typeFromNode = (file: SourceFile, node: ParsedNode, base: number): Parsed<TypeNode> =>
  Result.gen(function* typeFromNodeProgram() {
    const span = { end: base + node.range[1], start: base + node.range[0] };
    if (isMap(node)) {
      const seen = new Set<string>();
      const readField = (pair: Pair<ParsedNode, ParsedNode | null>): Parsed<Field> =>
        Result.gen(function* fieldProgram() {
          const keyOffset = base + pair.key.range[0];
          const key = scalarText(pair.key) ?? "";
          const optional = key.endsWith("?");
          const name = optional ? key.slice(0, -1) : key;
          if (reservedWords.has(name)) {
            return yield* Result.fail(
              syntaxError(
                file,
                keyOffset,
                Reason.InvalidIdentifier,
                `'${name}' is a reserved word and cannot be a field name.`,
              ),
            );
          }
          if (!identifierPattern.test(name)) {
            return yield* Result.fail(
              syntaxError(
                file,
                keyOffset,
                Reason.InvalidIdentifier,
                `'${name}' is not a valid field name. Use letters, digits and '_', and do not start with a digit.`,
              ),
            );
          }
          if (seen.has(name)) {
            return yield* Result.fail(
              syntaxError(
                file,
                keyOffset,
                Reason.DuplicateField,
                `The field '${name}' is declared twice.`,
              ),
            );
          }
          seen.add(name);
          if (pair.value === null) {
            return yield* Result.fail(
              syntaxError(file, keyOffset, Reason.InvalidType, `The field '${name}' has no type.`),
            );
          }
          const type = yield* typeFromNode(file, pair.value, base);
          return {
            name,
            optional,
            span: { end: base + pair.value.range[1], start: keyOffset },
            type,
          };
        });
      const fields: Field[] = [];
      for (const pair of node.items) {
        fields.push(yield* readField(pair));
      }
      return { _tag: "Struct" as const, fields, span };
    }
    if (isSeq(node)) {
      const [element, ...rest] = node.items;
      if (element === undefined || element === null || rest.length > 0) {
        return yield* Result.fail(
          syntaxError(
            file,
            span.start,
            Reason.InvalidType,
            "Write an array type with exactly one element type, for example '[String]' or 'Array(String)'.",
          ),
        );
      }
      return { _tag: "Array" as const, element: yield* typeFromNode(file, element, base), span };
    }
    const source = scalarText(node);
    if (source === undefined) {
      return yield* Result.fail(
        syntaxError(
          file,
          span.start,
          Reason.InvalidType,
          isAlias(node)
            ? "YAML aliases are not supported in input types."
            : "Expected a type such as 'String', 'Number' or 'Literal(\"a\", \"b\")'.",
        ),
      );
    }
    const typeStart = contentOffset(node, base);
    const tokens = yield* lex(file, source, 0, source.length, typeStart);
    const fail = (token: Lexeme | undefined, detail: string) =>
      Result.fail(
        syntaxError(
          file,
          token?.start ?? typeStart + source.trimEnd().length,
          Reason.InvalidType,
          detail,
        ),
      );
    const expect = (punctuation: string, at: number): Parsed<Lexeme> => {
      const token = tokens[at];
      return token?.text === punctuation
        ? Result.succeed(token)
        : fail(token, `Expected '${punctuation}' but found ${describeLexeme(token)}.`);
    };
    const literal = (at: number): Parsed<LiteralType> => {
      const token = tokens[at];
      if (token?.kind === LexemeKinds.string) {
        return Result.succeed(unescapeString(token.text));
      }
      if (token?.kind === LexemeKinds.number) {
        return Result.succeed(Number(token.text));
      }
      const bool = token === undefined ? undefined : booleanWords.get(token.text);
      return bool === undefined
        ? fail(
            token,
            `Literal accepts strings, numbers and booleans, but found ${describeLexeme(token)}.`,
          )
        : Result.succeed(bool);
    };
    const parseType = (at: number): Parsed<{ readonly type: TypeNode; readonly next: number }> =>
      Result.gen(function* typeProgram() {
        const token = tokens[at];
        if (token?.kind !== LexemeKinds.word) {
          return yield* fail(token, `Expected a type but found ${describeLexeme(token)}.`);
        }
        const primitive = lookup(PrimitiveTypes, token.text);
        if (primitive !== undefined) {
          return {
            next: at + 1,
            type: {
              _tag: "Primitive" as const,
              name: primitive,
              span: { end: token.end, start: token.start },
            },
          };
        }
        switch (token.text) {
          case TypeConstructors.Literal: {
            yield* expect("(", at + 1);
            const values: [LiteralType, ...LiteralType[]] = [yield* literal(at + 2)];
            for (let comma = at + 3; tokens[comma]?.text === ","; comma += 2) {
              values.push(yield* literal(comma + 1));
            }
            const closeAt = at + 2 * values.length + 1;
            const close = yield* expect(")", closeAt);
            return {
              next: closeAt + 1,
              type: {
                _tag: "Literal" as const,
                span: { end: close.end, start: token.start },
                values,
              },
            };
          }
          case TypeConstructors.Array: {
            yield* expect("(", at + 1);
            const element = yield* parseType(at + 2);
            const close = yield* expect(")", element.next);
            return {
              next: element.next + 1,
              type: {
                _tag: "Array" as const,
                element: element.type,
                span: { end: close.end, start: token.start },
              },
            };
          }
          case TypeConstructors.NullOr: {
            yield* expect("(", at + 1);
            const inner = yield* parseType(at + 2);
            const close = yield* expect(")", inner.next);
            return {
              next: inner.next + 1,
              type: {
                _tag: "NullOr" as const,
                span: { end: close.end, start: token.start },
                type: inner.type,
              },
            };
          }
          default: {
            return yield* fail(
              token,
              lookup(typeHints, token.text) ??
                `Unknown type '${token.text}'.${didYouMean(token.text, typeNames)}`,
            );
          }
        }
      });
    const { type, next } = yield* parseType(0);
    const rest = tokens[next];
    if (rest !== undefined) {
      return yield* fail(rest, `Unexpected ${describeLexeme(rest)} after the type.`);
    }
    return type;
  });

export const parseFrontmatter = (file: SourceFile, start: number, end: number) =>
  Result.gen(function* frontmatterProgram() {
    const document = parseDocument(file.text.slice(start, end), {
      prettyErrors: false,
      uniqueKeys: true,
    });
    const [yamlError] = document.errors;
    if (yamlError !== undefined) {
      return yield* Result.fail(
        syntaxError(
          file,
          start + yamlError.pos[0],
          Reason.InvalidYaml,
          `The frontmatter is not valid YAML: ${yamlError.message}.`,
        ),
      );
    }
    const span = { end, start };
    const { contents } = document;
    if (contents === null) {
      const empty: Frontmatter = { span };
      return empty;
    }
    if (!isMap(contents)) {
      return yield* Result.fail(
        syntaxError(
          file,
          start + contents.range[0],
          Reason.InvalidFrontmatter,
          "The frontmatter must be a YAML map with 'description', 'input' or 'schema'.",
        ),
      );
    }
    const readDescription = (value: ParsedNode | null, keyOffset: number): Parsed<string> => {
      const description = scalarText(value);
      return description === undefined
        ? Result.fail(
            syntaxError(
              file,
              keyOffset,
              Reason.InvalidFrontmatter,
              "'description' must be a string.",
            ),
          )
        : Result.succeed(description);
    };
    const readInput = (value: ParsedNode | null, keyOffset: number): Parsed<InputSpec> =>
      Result.gen(function* inputProgram() {
        if (value === null || !isMap(value)) {
          return yield* Result.fail(
            syntaxError(
              file,
              value === null ? keyOffset : start + value.range[0],
              Reason.InvalidFrontmatter,
              "'input' must be a map of field names to types. Write 'input: {}' for a prompt with no input.",
            ),
          );
        }
        const type = yield* typeFromNode(file, value, start);
        if (Predicate.isTagged(type, "Struct")) {
          return { _tag: "Inline" as const, type };
        }
        return yield* Result.fail(
          syntaxError(file, keyOffset, Reason.InvalidFrontmatter, "'input' must be a map."),
        );
      });
    const readSchema = (value: ParsedNode | null, keyOffset: number): Parsed<InputSpec> => {
      const reference = scalarText(value)?.trim() ?? "";
      const separator = reference.lastIndexOf("#");
      const exportName = reference.slice(separator + 1);
      return value === null || separator <= 0 || !identifierPattern.test(exportName)
        ? Result.fail(
            syntaxError(
              file,
              value === null ? keyOffset : contentOffset(value, start),
              Reason.InvalidSchemaReference,
              "Write the schema reference as '<module>#<ExportName>', for example './invoice.schema.ts#InvoiceInput'.",
            ),
          )
        : Result.succeed({
            _tag: "Reference",
            exportName,
            module: reference.slice(0, separator),
            span: { end: start + value.range[1], start: start + value.range[0] },
          });
    };
    const isInputKey = (pair: Pair<ParsedNode, ParsedNode | null>) => {
      const key = scalarText(pair.key);
      return key === FrontmatterKeys.input || key === FrontmatterKeys.schema;
    };
    const entries = yield* Result.all(
      contents.items.map((pair, index): Parsed<Omit<Frontmatter, "span">> => {
        const keyOffset = start + pair.key.range[0];
        const key = scalarText(pair.key) ?? "";
        if (isInputKey(pair) && contents.items.slice(0, index).some(isInputKey)) {
          return Result.fail(
            syntaxError(
              file,
              keyOffset,
              Reason.ConflictingInput,
              "Use either 'input' or 'schema', not both.",
            ),
          );
        }
        switch (key) {
          case FrontmatterKeys.description: {
            return Result.map(readDescription(pair.value, keyOffset), (description) => ({
              description,
            }));
          }
          case FrontmatterKeys.input: {
            return Result.map(readInput(pair.value, keyOffset), (input) => ({ input }));
          }
          case FrontmatterKeys.schema: {
            return Result.map(readSchema(pair.value, keyOffset), (input) => ({ input }));
          }
          default: {
            return Result.fail(
              syntaxError(
                file,
                keyOffset,
                Reason.UnknownFrontmatterKey,
                `Unknown frontmatter key '${key}'.${didYouMean(key, Object.values(FrontmatterKeys))}`,
              ),
            );
          }
        }
      }),
    );
    const description = entries.find((entry) => entry.description !== undefined)?.description;
    const input = entries.find((entry) => entry.input !== undefined)?.input;
    const frontmatter: Frontmatter = {
      ...whenDefined(description, (value) => ({ description: value })),
      ...whenDefined(input, (value) => ({ input: value })),
      span,
    };
    return frontmatter;
  });
