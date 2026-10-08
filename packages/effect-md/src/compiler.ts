import { lookup } from "./object.ts";
import { Array as Arr, Effect, Match, Option, Path, Predicate, Result } from "effect";
import { absurd } from "effect/Function";
import {
  ComparisonOperators,
  DataVariables,
  identifierPattern,
  PrimitiveTypes,
  Roles,
} from "./ast.ts";
import type * as Ast from "./ast.ts";
import { compileError, PromptCompileErrorReason as Reason } from "./compile-error.ts";
import type { PromptCompileError } from "./compile-error.ts";
import { didYouMean } from "./errors.ts";
import type { SourceFile } from "./errors.ts";
import { parse } from "./parser.ts";

const posix = Effect.runSync(
  Effect.gen(function* posixPath() {
    return yield* Path.Path;
  }).pipe(Effect.provide(Path.layer)),
);

type Compiled<A> = Result.Result<A, PromptCompileError>;

const ok: Compiled<null> = Result.succeed(null);

const promptSuffix = ".prompt.md";

const defaultRuntime = "@computis/effect-md/runtime";

const complexityBudget = 12;

const Helpers = {
  file: "file",
  json: "json",
  untrusted: "untrusted",
} as const;

const helperNames: ReadonlySet<string> = new Set(Object.values(Helpers));

const printablePrimitives: ReadonlySet<string> = new Set([
  PrimitiveTypes.Boolean,
  PrimitiveTypes.Number,
  PrimitiveTypes.String,
]);

const primitiveFills = {
  Boolean: (expression: string) => expression,
  Json: (expression: string) => `${expression} !== null`,
  Number: (expression: string) => `${expression} !== 0`,
  String: (expression: string) => `${expression} !== ""`,
};

const primitiveLiterals = {
  Boolean: Predicate.isBoolean,
  Json: () => true,
  Number: Predicate.isNumber,
  String: Predicate.isString,
};

const primitiveHints = {
  File: " Use '{{file value}}' to attach it.",
  Json: " Use '{{json value}}' to print it as JSON.",
};

const roleBuilders = {
  assistant: "Runtime.assistant",
  system: "Runtime.system",
  user: "Runtime.user",
};

interface ValueType {
  readonly node?: Ast.TypeNode;
  readonly optional: boolean;
  readonly nullable: boolean;
}

interface Binding {
  readonly expression: string;
  readonly type: ValueType;
  readonly constant?: Ast.LiteralValue;
}

interface SourceDocument {
  readonly document: Ast.PromptDocument;
  readonly file: SourceFile;
}

interface Context {
  readonly path: string;
  readonly file: SourceFile;
  readonly documents: ReadonlyMap<string, SourceDocument>;
  readonly scope: ReadonlyMap<string, Binding>;
  readonly dynamicInput: boolean;
  readonly aliases: ReadonlyMap<string, string>;
  readonly loop: { readonly index: string; readonly items: string } | null;
  readonly parts: string | null;
  readonly fileBlocked: string;
  readonly includes: ReadonlySet<string>;
}

interface Emitter {
  readonly lines: string[];
  readonly ternaries: Set<string>;
  readonly pieces: { readonly isStatic: boolean; readonly value: string }[];
  readonly counter: { value: number };
  depth: number;
  frame: { complexity: number };
}

const ternaryPattern =
  /^(?<indent> *)if \((?<condition>.*)\) \{\n\k<indent> {2}\$t \+= (?<whenTrue>.*);\n\k<indent>\} else \{\n\k<indent> {2}\$t \+= (?<whenFalse>.*);\n\k<indent>\}$/u;

const present: ValueType = { nullable: false, optional: false };

const fail = (
  ctx: Context,
  offset: number,
  reason: (typeof Reason)[keyof typeof Reason],
  detail: string,
) => Result.fail(compileError(ctx.file, offset, reason, detail));

const flush = (emitter: Emitter) => {
  const { pieces } = emitter;
  if (pieces.length === 0) {
    return;
  }
  const [only] = pieces;
  const dynamicCode =
    only !== undefined && pieces.length === 1
      ? only.value
      : `\`${pieces
          .map((piece) =>
            piece.isStatic
              ? piece.value
                  .replaceAll("\\", "\\\\")
                  .replaceAll("`", "\\`")
                  .replaceAll("${", "\\${")
                  .replaceAll("\n", "\\n")
                  .replaceAll("\r", "\\r")
              : `\${${piece.value}}`,
          )
          .join("")}\``;
  const code = pieces.every((piece) => piece.isStatic)
    ? JSON.stringify(pieces.map((piece) => piece.value).join(""))
    : dynamicCode;
  pieces.length = 0;
  emitter.lines.push(`${"  ".repeat(emitter.depth)}$t += ${code};`);
};

const statement = (emitter: Emitter, code: string) => {
  flush(emitter);
  emitter.lines.push(`${"  ".repeat(emitter.depth)}${code}`);
};

const open = (emitter: Emitter, code: string) => {
  statement(emitter, code);
  emitter.depth += 1;
};

const reopen = (emitter: Emitter, code: string) => {
  flush(emitter);
  emitter.depth -= 1;
  statement(emitter, code);
  emitter.depth += 1;
};

const close = (emitter: Emitter, code: string) => {
  flush(emitter);
  emitter.depth -= 1;
  statement(emitter, code);
};

const fresh = (counter: { value: number }) => {
  counter.value += 1;
  return counter.value;
};

const usesIdentifier = (code: string, identifier: string) =>
  new RegExp(`${identifier.replaceAll("$", "\\$")}\\b`, "u").test(code);

const normalizeType = (node: Ast.TypeNode, optional: boolean): ValueType =>
  Predicate.isTagged(node, "NullOr")
    ? { node: node.type, nullable: true, optional }
    : { node, nullable: false, optional };

const describeType = (node: Ast.TypeNode): string =>
  Match.valueTags(node, {
    Array: (array) => `an array of ${describeType(array.element)}`,
    Literal: (literal) =>
      `Literal(${literal.values.map((value) => JSON.stringify(value)).join(", ")})`,
    NullOr: (nullable) => `NullOr(${describeType(nullable.type)})`,
    Primitive: (primitiveType) => `a ${primitiveType.name}`,
    Struct: () => "a struct",
  });

const displayName = (value: Ast.ValueExpression) =>
  Predicate.isTagged(value, "Data") ? `@${value.name}` : [value.root, ...value.segments].join(".");

const isMissing = (binding: Binding) => binding.type.optional || binding.type.nullable;

const withAlias = (ctx: Context, binding: Binding): Binding => {
  const alias = ctx.aliases.get(binding.expression);
  return alias === undefined
    ? binding
    : { expression: alias, type: { ...binding.type, ...present } };
};

const primitive = (name: Ast.PrimitiveType, span: Ast.Span): ValueType => ({
  ...present,
  node: { _tag: "Primitive", name, span },
});

const presenceChecks = (binding: Binding) => {
  const { expression, type } = binding;
  const dynamic = type.node === undefined;
  return [
    ...(dynamic || type.optional ? [`${expression} !== undefined`] : []),
    ...(dynamic || type.nullable ? [`${expression} !== null`] : []),
  ];
};

const resolveValue = (ctx: Context, value: Ast.ValueExpression): Compiled<Binding> => {
  if (Predicate.isTagged(value, "Data")) {
    const { loop } = ctx;
    if (loop === null) {
      return fail(
        ctx,
        value.span.start,
        Reason.UnknownVariable,
        `'@${value.name}' is only available inside '{{#each}}'.`,
      );
    }
    switch (value.name) {
      case DataVariables.index: {
        return Result.succeed({
          expression: loop.index,
          type: primitive(PrimitiveTypes.Number, value.span),
        });
      }
      case DataVariables.first: {
        return Result.succeed({
          expression: `${loop.index} === 0`,
          type: primitive(PrimitiveTypes.Boolean, value.span),
        });
      }
      case DataVariables.last: {
        return Result.succeed({
          expression: `${loop.index} === ${loop.items}.length - 1`,
          type: primitive(PrimitiveTypes.Boolean, value.span),
        });
      }
      default: {
        return absurd(value.name);
      }
    }
  }
  const root = ctx.scope.get(value.root);
  if (root === undefined && !ctx.dynamicInput) {
    return fail(
      ctx,
      value.span.start,
      Reason.UnknownVariable,
      `Unknown variable '${value.root}'. Declare it under 'input' in the frontmatter.${didYouMean(value.root, ctx.scope.keys())}`,
    );
  }
  const resolvedRoot: Compiled<Binding> = Result.succeed(
    withAlias(ctx, root ?? { expression: `$input.${value.root}`, type: present }),
  );
  return Arr.reduce(value.segments, resolvedRoot, (resolved, segment, index) =>
    resolved.pipe(
      Result.flatMap((binding) => {
        const { node } = binding.type;
        const name = [value.root, ...value.segments.slice(0, index)].join(".");
        if (node === undefined) {
          return Result.succeed(
            withAlias(ctx, { expression: `${binding.expression}.${segment}`, type: present }),
          );
        }
        if (isMissing(binding)) {
          return fail(
            ctx,
            value.span.start,
            Reason.MissingValue,
            `'${name}' may be missing. Check it first with '{{#if ${name}}}'.`,
          );
        }
        if (!Predicate.isTagged(node, "Struct")) {
          return fail(
            ctx,
            value.span.start,
            Reason.NotAStruct,
            `'${name}' is ${describeType(node)}, so it has no field '${segment}'.`,
          );
        }
        const field = node.fields.find((candidate) => candidate.name === segment);
        if (field === undefined) {
          return fail(
            ctx,
            value.span.start,
            Reason.UnknownField,
            `'${name}' has no field '${segment}'.${didYouMean(
              segment,
              node.fields.map((candidate) => candidate.name),
            )}`,
          );
        }
        return Result.succeed(
          withAlias(ctx, {
            expression: `${binding.expression}.${segment}`,
            type: normalizeType(field.type, field.optional),
          }),
        );
      }),
    ),
  );
};

const ValueKinds = {
  array: "array",
  file: "file",
  printable: "printable",
  string: "string",
} as const;

const kindDescriptions = {
  array: "an array",
  file: "a File",
  printable: "a String, a Number, a Boolean or a Literal",
  string: "a String",
};

const kindChecks = {
  array: (node: Ast.TypeNode) => Predicate.isTagged(node, "Array"),
  file: (node: Ast.TypeNode) =>
    Predicate.isTagged(node, "Primitive") && node.name === PrimitiveTypes.File,
  printable: (node: Ast.TypeNode) =>
    Predicate.isTagged(node, "Literal") ||
    (Predicate.isTagged(node, "Primitive") && printablePrimitives.has(node.name)),
  string: (node: Ast.TypeNode) =>
    (Predicate.isTagged(node, "Primitive") && node.name === PrimitiveTypes.String) ||
    (Predicate.isTagged(node, "Literal") && node.values.every(Predicate.isString)),
};

const requireValue = (
  ctx: Context,
  binding: Binding,
  value: Ast.ValueExpression,
  kind: (typeof ValueKinds)[keyof typeof ValueKinds],
): Compiled<Binding> => {
  const name = displayName(value);
  if (isMissing(binding)) {
    return fail(
      ctx,
      value.span.start,
      Reason.MissingValue,
      `'${name}' may be missing. Check it first with '{{#if ${name}}}'.`,
    );
  }
  const { node } = binding.type;
  if (node === undefined || kindChecks[kind](node)) {
    return Result.succeed(binding);
  }
  const hint = Match.valueTags(node, {
    Array: () => " Use '{{#each}}' or '{{json value}}'.",
    Literal: () => "",
    NullOr: () => "",
    Primitive: (primitiveType) => lookup(primitiveHints, primitiveType.name) ?? "",
    Struct: () => " Use '{{json value}}' to print it as JSON.",
  });
  return fail(
    ctx,
    value.span.start,
    kind === ValueKinds.array ? Reason.InvalidIterable : Reason.InvalidOutput,
    `'${name}' is ${describeType(node)}, but ${kindDescriptions[kind]} is expected here.${hint}`,
  );
};

const emitCondition = (
  ctx: Context,
  condition: Ast.Condition,
): Compiled<{
  readonly code: string;
  readonly constant: boolean | null;
  readonly negated: string | null;
  readonly cost: number;
  readonly whenTrue: readonly string[];
  readonly whenFalse: readonly string[];
}> =>
  Match.valueTags(condition, {
    Compare: (compare) =>
      Result.gen(function* compareProgram() {
        const binding = yield* resolveValue(ctx, compare.left);
        const { node } = binding.type;
        const literal = compare.right.value;
        const equals = compare.operator === ComparisonOperators.equals;
        const narrows = isMissing(binding) ? [binding.expression] : [];
        if (binding.constant !== undefined) {
          return {
            code: "",
            constant: (binding.constant === literal) === equals,
            cost: 0,
            negated: null,
            whenFalse: [],
            whenTrue: [],
          };
        }
        if (literal !== null) {
          const accepted =
            node === undefined ||
            Match.valueTags(node, {
              Array: () => false,
              Literal: (literalType) =>
                literalType.values.some((candidate) => candidate === literal),
              NullOr: () => true,
              Primitive: (primitiveType) =>
                lookup(primitiveLiterals, primitiveType.name)?.(literal) ?? false,
              Struct: () => false,
            });
          if (node !== undefined && !accepted) {
            return yield* fail(
              ctx,
              compare.right.span.start,
              Reason.LiteralMismatch,
              `'${displayName(compare.left)}' is ${describeType(node)}, so it is never ${JSON.stringify(literal)}.`,
            );
          }
          const value = JSON.stringify(literal);
          return {
            code: `${binding.expression} ${compare.operator}= ${value}`,
            constant: null,
            cost: 0,
            negated: equals ? null : `${binding.expression} === ${value}`,
            whenFalse: equals ? [] : narrows,
            whenTrue: equals ? narrows : [],
          };
        }
        const checks = presenceChecks(binding);
        if (checks.length === 0) {
          return yield* fail(
            ctx,
            compare.right.span.start,
            Reason.ConstantCondition,
            `'${displayName(compare.left)}' is never null, so this condition is always ${equals ? "false" : "true"}.`,
          );
        }
        const absent = checks.map((check) => check.replace(" !== ", " === "));
        const [single] = absent;
        return {
          code: equals ? absent.join(" || ") : checks.join(" && "),
          constant: null,
          cost: checks.length - 1,
          negated: !equals && checks.length === 1 && single !== undefined ? single : null,
          whenFalse: equals ? narrows : [],
          whenTrue: equals ? [] : narrows,
        };
      }),
    Not: (not) =>
      Result.map(emitCondition(ctx, not.condition), (inner) => ({
        code: inner.negated ?? `!(${inner.code})`,
        constant: inner.constant === null ? null : !inner.constant,
        cost: inner.cost,
        negated: inner.negated === null ? inner.code : null,
        whenFalse: inner.whenTrue,
        whenTrue: inner.whenFalse,
      })),
    Truthy: (truthy) =>
      Result.gen(function* truthyProgram() {
        const binding = yield* resolveValue(ctx, truthy.value);
        const { expression, type } = binding;
        const { node } = type;
        if (binding.constant !== undefined) {
          const value = binding.constant;
          return {
            code: "",
            constant: !(value === null || value === false || value === 0 || value === ""),
            cost: 0,
            negated: null,
            whenFalse: [],
            whenTrue: [],
          };
        }
        const fills: readonly string[] =
          node === undefined
            ? [`Runtime.isFilled(${expression})`]
            : Match.valueTags(node, {
                Array: () => [`${expression}.length > 0`],
                Literal: (literalType) =>
                  literalType.values.every(Predicate.isBoolean)
                    ? [expression]
                    : literalType.values
                        .filter((value) => value === false || value === 0 || value === "")
                        .map((value) => `${expression} !== ${JSON.stringify(value)}`),
                NullOr: () => [],
                Primitive: (primitiveType) => {
                  const fill = lookup(primitiveFills, primitiveType.name);
                  return fill === undefined ? [] : [fill(expression)];
                },
                Struct: () => [],
              });
        const checks = [...presenceChecks(binding), ...fills];
        if (checks.length === 0) {
          return yield* fail(
            ctx,
            truthy.value.span.start,
            Reason.ConstantCondition,
            `'${displayName(truthy.value)}' is always present, so this condition is always true.`,
          );
        }
        const [single] = checks;
        return {
          code: checks.join(" && "),
          constant: null,
          cost: checks.length - 1,
          negated:
            checks.length === 1 && single !== undefined && single.includes(" !== ")
              ? single.replace(" !== ", " === ")
              : null,
          whenFalse: [],
          whenTrue: isMissing(binding) ? [expression] : [],
        };
      }),
  });

const hashLiteral = (
  ctx: Context,
  helper: Extract<Ast.Node, { readonly _tag: "Helper" }>,
  allowed: string | null,
  accepts: (value: Ast.LiteralValue) => boolean,
  expected: string,
): Compiled<string> => {
  const unknown = helper.hash.find((argument) => argument.name !== allowed);
  if (unknown !== undefined) {
    return fail(
      ctx,
      unknown.span.start,
      Reason.InvalidHelperArgument,
      `'{{${helper.name}}}' does not accept '${unknown.name}'.${allowed === null ? "" : ` It accepts only '${allowed}'.`}`,
    );
  }
  const [option] = helper.hash;
  if (option === undefined) {
    return Result.succeed("");
  }
  return Predicate.isTagged(option.value, "Literal") && accepts(option.value.value)
    ? Result.succeed(`, ${JSON.stringify(option.value.value)}`)
    : fail(
        ctx,
        option.span.start,
        Reason.InvalidHelperArgument,
        `'${option.name}' must be ${expected}.`,
      );
};

const declareAliases = (ctx: Context, emitter: Emitter, expressions: readonly string[]) => {
  const aliases = new Map(ctx.aliases);
  const declared: { readonly name: string; readonly line: number }[] = [];
  for (const expression of expressions) {
    const name = `$n${fresh(emitter.counter)}`;
    declared.push({ line: emitter.lines.length, name });
    statement(emitter, `const ${name} = ${expression};`);
    aliases.set(expression, name);
  }
  return { ctx: declared.length === 0 ? ctx : { ...ctx, aliases }, declared };
};

const pruneAliases = (
  emitter: Emitter,
  declared: readonly { readonly name: string; readonly line: number }[],
) => {
  flush(emitter);
  for (const alias of declared.toReversed()) {
    const rest = emitter.lines.slice(alias.line + 1).join("\n");
    if (!usesIdentifier(rest, alias.name)) {
      emitter.lines.splice(alias.line, 1);
    }
  }
};

const splitWhenComplex = (emitter: Emitter, emit: () => Compiled<null>): Compiled<null> => {
  if (emitter.frame.complexity < complexityBudget) {
    return emit();
  }
  const name = `$block${fresh(emitter.counter)}`;
  const outer = emitter.frame;
  open(emitter, `const ${name} = () => {`);
  emitter.frame = { complexity: 1 };
  const result = emit();
  close(emitter, "};");
  emitter.frame = outer;
  statement(emitter, `${name}();`);
  return result;
};

const emitNodes = (ctx: Context, emitter: Emitter, nodes: readonly Ast.Node[]): Compiled<null> =>
  Result.gen(function* nodesProgram() {
    for (const node of nodes) {
      yield* Match.valueTags(node, {
        Each: (each) =>
          splitWhenComplex(emitter, () =>
            Result.gen(function* eachProgram() {
              const found = yield* resolveValue(ctx, each.iterable);
              const iterable = yield* requireValue(ctx, found, each.iterable, ValueKinds.array);
              const id = fresh(emitter.counter);
              const items = `$xs${id}`;
              const index = `$i${id}`;
              const item = `$v${id}`;
              statement(emitter, `const ${items} = ${iterable.expression};`);
              if (each.alternate.length > 0) {
                emitter.frame.complexity += 1;
                open(emitter, `if (${items}.length === 0) {`);
                yield* emitNodes(ctx, emitter, each.alternate);
                reopen(emitter, "} else {");
              }
              emitter.frame.complexity += 1;
              const header = emitter.lines.length;
              const headerIndent = "  ".repeat(emitter.depth);
              open(emitter, "");
              const iterableNode = iterable.type.node;
              const element =
                iterableNode !== undefined && Predicate.isTagged(iterableNode, "Array")
                  ? normalizeType(iterableNode.element, false)
                  : present;
              const scope = new Map(ctx.scope);
              scope.set(each.item, { expression: item, type: element });
              if (each.index !== undefined) {
                scope.set(each.index, {
                  expression: index,
                  type: primitive(PrimitiveTypes.Number, each.span),
                });
              }
              yield* emitNodes({ ...ctx, loop: { index, items }, scope }, emitter, each.body);
              close(emitter, "}");
              const body = emitter.lines.slice(header + 1).join("\n");
              const usesItem = usesIdentifier(body, item);
              const counting = `let ${index} = 0; ${index} < ${items}.length; ${index} += 1`;
              const iterating = usesIdentifier(body, index)
                ? `const [${index}, ${item}] of ${items}.entries()`
                : `const ${item} of ${items}`;
              emitter.lines[header] = `${headerIndent}for (${usesItem ? iterating : counting}) {`;
              if (each.alternate.length > 0) {
                close(emitter, "}");
              }
              return null;
            }),
          ),
        Helper: (helper) =>
          Result.gen(function* helperProgram() {
            const [argument, ...extra] = helper.args;
            if (!helperNames.has(helper.name)) {
              return yield* fail(
                ctx,
                helper.span.start,
                Reason.UnknownHelper,
                `Unknown helper '${helper.name}'. Use 'untrusted', 'json' or 'file'.${didYouMean(helper.name, helperNames)}`,
              );
            }
            if (
              argument === undefined ||
              extra.length > 0 ||
              Predicate.isTagged(argument, "Literal")
            ) {
              return yield* fail(
                ctx,
                helper.span.start,
                Reason.InvalidHelperArgument,
                `'{{${helper.name}}}' takes one variable, for example '{{${helper.name} value}}'.`,
              );
            }
            const binding = yield* resolveValue(ctx, argument);
            switch (helper.name) {
              case Helpers.json: {
                const indent = yield* hashLiteral(
                  ctx,
                  helper,
                  "indent",
                  Predicate.isNumber,
                  "a number",
                );
                emitter.pieces.push({
                  isStatic: false,
                  value: `Runtime.json(${binding.expression}${indent})`,
                });
                return null;
              }
              case Helpers.untrusted: {
                const text = yield* requireValue(ctx, binding, argument, ValueKinds.string);
                const lang = yield* hashLiteral(
                  ctx,
                  helper,
                  "lang",
                  Predicate.isString,
                  "a string",
                );
                emitter.pieces.push({
                  isStatic: false,
                  value: `Runtime.untrusted(${text.expression}${lang})`,
                });
                return null;
              }
              default: {
                yield* hashLiteral(ctx, helper, null, Predicate.isString, "nothing");
                const attachment = yield* requireValue(ctx, binding, argument, ValueKinds.file);
                if (ctx.parts === null) {
                  return yield* fail(
                    ctx,
                    helper.span.start,
                    Reason.FileNotAllowed,
                    ctx.fileBlocked,
                  );
                }
                statement(
                  emitter,
                  `${ctx.parts}.push($t, Runtime.file(${attachment.expression}));`,
                );
                statement(emitter, `$t = "";`);
                return null;
              }
            }
          }),
        If: (block) =>
          splitWhenComplex(emitter, () =>
            Result.gen(function* ifProgram() {
              const evaluated: {
                readonly body: readonly Ast.Node[];
                readonly condition: Result.Result.Success<ReturnType<typeof emitCondition>>;
              }[] = [];
              for (const branch of block.branches) {
                const condition = yield* emitCondition(ctx, branch.condition);
                evaluated.push({ body: branch.body, condition });
                if (condition.constant === true) {
                  break;
                }
              }
              const branches = evaluated.filter(({ condition }) => condition.constant === null);
              const alternate =
                evaluated.find(({ condition }) => condition.constant === true)?.body ??
                block.alternate;
              if (branches.length === 0) {
                return yield* emitNodes(ctx, emitter, alternate);
              }
              flush(emitter);
              const start = emitter.lines.length;
              const falsy: string[] = [];
              const last = branches.length - 1;
              const swapped = Option.filter(
                Option.fromNullishOr(branches.at(-1)),
                (branch) => alternate.length > 0 && branch.condition.negated !== null,
              );
              for (const [index, { body, condition }] of branches.entries()) {
                const swap = index === last && Option.isSome(swapped);
                const code = (swap ? condition.negated : null) ?? condition.code;
                emitter.frame.complexity += 1 + condition.cost;
                if (index === 0) {
                  open(emitter, `if (${code}) {`);
                } else {
                  reopen(emitter, `} else if (${code}) {`);
                }
                const narrowed = declareAliases(ctx, emitter, [
                  ...falsy,
                  ...(swap ? condition.whenFalse : condition.whenTrue),
                ]);
                yield* emitNodes(narrowed.ctx, emitter, swap ? alternate : body);
                pruneAliases(emitter, narrowed.declared);
                if (!swap) {
                  falsy.push(...condition.whenFalse);
                }
              }
              const otherwise = Option.match(swapped, {
                onNone: () => ({ body: alternate, narrows: [] }),
                onSome: (branch) => ({ body: branch.body, narrows: branch.condition.whenTrue }),
              });
              if (otherwise.body.length > 0) {
                reopen(emitter, "} else {");
                const narrowed = declareAliases(ctx, emitter, [...falsy, ...otherwise.narrows]);
                yield* emitNodes(narrowed.ctx, emitter, otherwise.body);
                pruneAliases(emitter, narrowed.declared);
              }
              close(emitter, "}");
              const collapsible = emitter.lines.slice(start);
              const joined = collapsible.join("\n");
              const ternary = joined.replace(
                ternaryPattern,
                "$<indent>$$t += $<condition> ? $<whenTrue> : $<whenFalse>;",
              );
              if (ternary !== joined && !collapsible.some((line) => emitter.ternaries.has(line))) {
                emitter.lines.splice(start, collapsible.length, ternary);
                emitter.ternaries.add(ternary);
              }
              return null;
            }),
          ),
        Output: (output) =>
          Result.gen(function* outputProgram() {
            const found = yield* resolveValue(ctx, output.value);
            const binding = yield* requireValue(ctx, found, output.value, ValueKinds.printable);
            const outputNode = binding.type.node;
            const isString =
              outputNode !== undefined &&
              Predicate.isTagged(outputNode, "Primitive") &&
              outputNode.name === PrimitiveTypes.String;
            emitter.pieces.push({
              isStatic: false,
              value: isString ? binding.expression : `Runtime.show(${binding.expression})`,
            });
            return null;
          }),
        Partial: (partial) =>
          Result.gen(function* partialProgram() {
            const target = posix.join(posix.dirname(ctx.path), partial.source);
            const included = ctx.documents.get(target);
            if (included === undefined) {
              const partials = [...ctx.documents.keys()].filter(
                (path) => !path.endsWith(promptSuffix),
              );
              return yield* fail(
                ctx,
                partial.span.start,
                Reason.MissingPartial,
                `The partial '${partial.source}' does not exist (looked for '${target}').${didYouMean(target, partials)}`,
              );
            }
            if (ctx.includes.has(target)) {
              return yield* fail(
                ctx,
                partial.span.start,
                Reason.CyclicPartial,
                `The partials include each other: ${[...ctx.includes, target].join(" → ")}.`,
              );
            }
            const { body, frontmatter } = included.document;
            if (!Predicate.isTagged(body, "Fragment")) {
              return yield* fail(
                ctx,
                partial.span.start,
                Reason.InvalidPartial,
                `The partial '${partial.source}' uses role tags. Only prompt files can use '<system>', '<user>' and '<assistant>'.`,
              );
            }
            const scope = new Map(ctx.scope);
            for (const argument of partial.hash) {
              const { value } = argument;
              if (Predicate.isTagged(value, "Literal")) {
                const literal = value.value;
                scope.set(argument.name, {
                  constant: literal,
                  expression: JSON.stringify(literal),
                  type:
                    literal === null
                      ? { nullable: true, optional: false }
                      : {
                          ...present,
                          node: { _tag: "Literal", span: value.span, values: [literal] },
                        },
                });
              } else {
                scope.set(argument.name, yield* resolveValue(ctx, value));
              }
            }
            const input = frontmatter?.input;
            const needed =
              input !== undefined && Predicate.isTagged(input, "Inline") && !ctx.dynamicInput
                ? input.type.fields.find((field) => !field.optional && !scope.has(field.name))
                : undefined;
            if (needed !== undefined) {
              return yield* fail(
                ctx,
                partial.span.start,
                Reason.MissingPartialInput,
                `The partial '${partial.source}' needs '${needed.name}'. Pass it with '{{> ${partial.source} ${needed.name}=...}}'.`,
              );
            }
            const inner: Context = {
              ...ctx,
              file: included.file,
              includes: new Set([...ctx.includes, target]),
              path: target,
              scope,
            };
            if (partial.indent.length === 0) {
              return yield* emitNodes(inner, emitter, body.nodes);
            }
            const saved = `$s${fresh(emitter.counter)}`;
            statement(emitter, `const ${saved} = $t;`);
            statement(emitter, `$t = "";`);
            yield* emitNodes(
              {
                ...inner,
                fileBlocked: "'{{file}}' cannot be used in an indented partial.",
                parts: null,
              },
              emitter,
              body.nodes,
            );
            statement(
              emitter,
              `$t = \`\${${saved}}\${Runtime.indent($t, ${JSON.stringify(partial.indent)})}\`;`,
            );
            return null;
          }),
        Text: (text) => {
          emitter.pieces.push({ isStatic: true, value: text.value });
          return ok;
        },
      });
    }
    return null;
  });

const schemaCode = (node: Ast.TypeNode): string =>
  Match.valueTags(node, {
    Array: (array) => `Schema.Array(${schemaCode(array.element)})`,
    Literal: (literal) =>
      literal.values.length === 1
        ? `Schema.Literal(${JSON.stringify(literal.values[0])})`
        : `Schema.Literals([${literal.values.map((value) => JSON.stringify(value)).join(", ")}])`,
    NullOr: (nullable) => `Schema.NullOr(${schemaCode(nullable.type)})`,
    Primitive: (primitiveType) =>
      primitiveType.name === PrimitiveTypes.File ? "Runtime.File" : `Schema.${primitiveType.name}`,
    Struct: (struct) =>
      `Schema.Struct({ ${struct.fields
        .toSorted((left, right) => (left.name < right.name ? -1 : 1))
        .map((field) => {
          const code = schemaCode(field.type);
          return `${field.name}: ${field.optional ? `Schema.optionalKey(${code})` : code}`;
        })
        .join(", ")} })`,
  });

export const compile = (
  sources: readonly { readonly path: string; readonly text: string }[],
  options: { readonly runtime?: string; readonly displayPath?: (path: string) => string } = {},
) =>
  Effect.gen(function* compileProgram() {
    const parsed = yield* Effect.all(
      sources.map((source) => {
        const path = posix.normalize(source.path);
        const file: SourceFile = { path: options.displayPath?.(path) ?? path, text: source.text };
        return Effect.map(
          parse(source.text, { path: file.path ?? path }),
          (document) => [path, { document, file }] as const,
        );
      }),
    );
    const documents: ReadonlyMap<string, SourceDocument> = new Map(
      parsed.toSorted(([left], [right]) => (left < right ? -1 : 1)),
    );
    const runtime = options.runtime ?? defaultRuntime;

    return yield* Effect.fromResult(
      Result.gen(function* generateProgram() {
        const counter = { value: 0 };
        const hoisted: string[] = [];
        const imports: string[] = [];
        const names = new Set<string>();
        const leaves: { readonly keys: readonly string[]; readonly code: string }[] = [];

        const compilePrompt = (path: string, source: SourceDocument): Compiled<string> =>
          Result.gen(function* promptProgram() {
            const { document, file } = source;
            const input = document.frontmatter?.input;
            const base: Context = {
              aliases: new Map(),
              documents,
              dynamicInput: false,
              file,
              fileBlocked: "Files are allowed only in '<user>' and '<assistant>' messages.",
              includes: new Set([path]),
              loop: null,
              parts: null,
              path,
              scope: new Map(),
            };
            const { ctx, inputCode } = Match.value(input).pipe(
              Match.withReturnType<{ readonly ctx: Context; readonly inputCode: string }>(),
              Match.when(Match.undefined, () => ({ ctx: base, inputCode: "Schema.Void" })),
              Match.tag("Inline", (inline) => ({
                ctx: {
                  ...base,
                  scope: new Map(
                    inline.type.fields.map((field) => [
                      field.name,
                      {
                        expression: `$input.${field.name}`,
                        type: normalizeType(field.type, field.optional),
                      },
                    ]),
                  ),
                },
                inputCode: schemaCode(inline.type),
              })),
              Match.tag("Reference", (reference) => {
                const schemaName = `$schema${fresh(counter)}`;
                const module = reference.module.startsWith(".")
                  ? `./${posix.join(posix.dirname(path), reference.module)}`
                  : reference.module;
                imports.push(
                  `import { ${reference.exportName} as ${schemaName} } from ${JSON.stringify(module)};`,
                );
                return { ctx: { ...base, dynamicInput: true }, inputCode: schemaName };
              }),
              Match.exhaustive,
            );
            const messages: readonly Ast.Message[] = Predicate.isTagged(document.body, "Fragment")
              ? [
                  {
                    body: document.body.nodes,
                    role: Roles.user,
                    span: { end: file.text.length, start: 0 },
                  },
                ]
              : document.body.messages;
            const renderLines: string[] = [];
            const staticMessages: string[] = [];
            const frame = { complexity: 1 };
            const emitMessage = (message: Ast.Message, index: number): Compiled<null> =>
              Result.gen(function* messageProgram() {
                const emitter: Emitter = {
                  counter,
                  depth: 2,
                  frame,
                  lines: [],
                  pieces: [],
                  ternaries: new Set(),
                };
                const parts = message.role === Roles.system ? null : `$p${fresh(counter)}`;
                yield* emitNodes({ ...ctx, parts }, emitter, message.body);
                const builder = roleBuilders[message.role];
                if (emitter.lines.length === 0 && emitter.pieces.every((piece) => piece.isStatic)) {
                  const text = JSON.stringify(emitter.pieces.map((piece) => piece.value).join(""));
                  const name = `$m${fresh(counter)}`;
                  hoisted.push(
                    `const ${name} = ${builder}(${parts === null ? text : `[${text}]`});`,
                  );
                  staticMessages.push(name);
                  renderLines.push(`    $messages.push(${name});`);
                  return null;
                }
                flush(emitter);
                if (staticMessages.length < index) {
                  renderLines.push(`    $t = "";`);
                }
                if (parts === null) {
                  renderLines.push(...emitter.lines, `    $messages.push(${builder}($t));`);
                  return null;
                }
                renderLines.push(
                  `    const ${parts}: Runtime.Part[] = [];`,
                  ...emitter.lines,
                  `    ${parts}.push($t);`,
                  `    $messages.push(${builder}(${parts}));`,
                );
                return null;
              });
            for (const [index, message] of messages.entries()) {
              yield* emitMessage(message, index);
            }
            const staticPrompt =
              staticMessages.length < messages.length ? undefined : `$prompt${fresh(counter)}`;
            if (staticPrompt !== undefined) {
              hoisted.push(
                `const ${staticPrompt} = Prompt.fromMessages([${staticMessages.join(", ")}]);`,
              );
            }
            const body = renderLines.join("\n");
            const parameter = usesIdentifier(body, "$input") ? "$input" : "";
            const render =
              staticPrompt === undefined
                ? `(${parameter}) => {\n    let $t = "";\n    const $messages: Prompt.Message[] = [];\n${body}\n    return Prompt.fromMessages($messages);\n  }`
                : `() => ${staticPrompt}`;
            const description = document.frontmatter?.description;
            const fields = [
              ...(description === undefined ? [] : [`description: ${JSON.stringify(description)}`]),
              `input: ${inputCode}`,
              `name: ${JSON.stringify(path.slice(0, -promptSuffix.length))}`,
              `render: ${render}`,
            ];
            return `Runtime.definePrompt({\n  ${fields.join(",\n  ")},\n})`;
          });

        for (const [path, source] of documents) {
          if (!path.endsWith(promptSuffix)) {
            continue;
          }
          const keys = path
            .slice(0, -promptSuffix.length)
            .split("/")
            .map((segment) =>
              segment.replaceAll(/[-_.](?<char>[A-Za-z0-9])/gu, (_, char: string) =>
                char.toUpperCase(),
              ),
            );
          const invalid = keys.find((key) => !identifierPattern.test(key));
          if (invalid !== undefined) {
            return yield* Result.fail(
              compileError(
                source.file,
                0,
                Reason.InvalidPromptName,
                `The path '${path}' does not give a valid name: '${invalid}'. Use letters, digits and '-' in file and folder names, and do not start with a digit.`,
              ),
            );
          }
          const key = keys.join(".");
          const clashes = [...names].some(
            (other) => other === key || other.startsWith(`${key}.`) || key.startsWith(`${other}.`),
          );
          if (clashes) {
            return yield* Result.fail(
              compileError(
                source.file,
                0,
                Reason.DuplicatePromptName,
                `Another prompt already uses the name '${key}'.`,
              ),
            );
          }
          names.add(key);
          leaves.push({ code: yield* compilePrompt(path, source), keys });
        }

        const renderTree = (prefix: readonly string[], depth: number): string => {
          const indent = "  ".repeat(depth);
          const entries = new Map<string, string>();
          for (const leaf of leaves) {
            const next = leaf.keys[prefix.length];
            const matches = prefix.every((key, index) => leaf.keys[index] === key);
            if (matches && next !== undefined && leaf.keys.length === prefix.length + 1) {
              entries.set(next, `${indent}${next}: ${leaf.code.replaceAll("\n", `\n${indent}`)},`);
            } else if (matches && next !== undefined && !entries.has(next)) {
              entries.set(
                next,
                `${indent}${next}: {\n${renderTree([...prefix, next], depth + 1)}\n${indent}},`,
              );
            }
          }
          return [...entries]
            .toSorted(([left], [right]) => (left < right ? -1 : 1))
            .map(([, code]) => code)
            .join("\n");
        };

        const body = [...hoisted, "", `export const prompts = {\n${renderTree([], 1)}\n};`].join(
          "\n",
        );
        const header = [
          "// This file is generated by @computis/effect-md. Do not edit it.",
          ...(body.includes("Schema.") ? [`import { Schema } from "effect";`] : []),
          ...(body.includes("Prompt.") ? [`import { Prompt } from "effect/ai";`] : []),
          `import * as Runtime from ${JSON.stringify(runtime)};`,
          ...imports,
        ];
        return `${header.join("\n")}\n\n${body}\n`;
      }),
    );
  });
