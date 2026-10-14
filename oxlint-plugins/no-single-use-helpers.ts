import { definePlugin, defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";
import { isImportedElsewhere } from "./import-index.ts";
import { isObject, isString } from "./predicates.ts";

interface Span {
  end?: number;
  range?: readonly [number, number];
  start?: number;
}

type NodeLike = { type: string } & Span & Record<string, unknown>;

interface Candidate {
  contractReferences: number;
  declarationEnd: number;
  declarationStart: number;
  exported: boolean;
  exposed: boolean;
  id: ESTree.Node & { readonly name: string };
  kind: "constant" | "helper" | "interface" | "type alias";
  nested: boolean;
  positions: number[];
  references: number;
  repeated: boolean;
  scopeEnd: number;
  scopeStart: number;
  selfReferences: number;
}

interface Candidates {
  readonly nested: readonly Candidate[];
  readonly topLevel: ReadonlyMap<string, Candidate>;
}

const isNode = (value: unknown): value is NodeLike =>
  isObject(value) && "type" in value && isString(value.type);

const spanStart = (span: Span) => span.start ?? span.range?.[0] ?? -1;

const spanEnd = (span: Span) => span.end ?? span.range?.[1] ?? -1;

const SKIPPED_KEYS = new Set(["superTypeArguments", "typeParameters"]);

// A class contract and a re-export are not call sites: neither one can absorb the
// declaration, so neither one makes it inlinable.
const CONTRACT_TYPES = new Set(["TSClassImplements", "TSInterfaceHeritage"]);

// The only child that can hold a reference: an export wrapper forwards to its declaration,
// and a member, property, or qualified name only reads its own left side.
const SOLE_CHILD_KEYS = new Map([
  ["ExportDefaultDeclaration", "declaration"],
  ["ExportNamedDeclaration", "declaration"],
  ["MemberExpression", "object"],
  ["Property", "value"],
  ["TSPropertySignature", "typeAnnotation"],
  ["TSQualifiedName", "left"],
]);

const soleChildKey = (node: NodeLike) =>
  (node.type === "Property" ||
    node.type === "MemberExpression" ||
    node.type === "TSPropertySignature") &&
  node.computed !== false
    ? undefined
    : SOLE_CHILD_KEYS.get(node.type);

const walk = (
  node: NodeLike,
  visit: (node: NodeLike, contract: boolean) => void,
  contract = false,
) => {
  visit(node, contract);

  if (node.type === "ImportDeclaration") {
    return;
  }

  const soleKey = soleChildKey(node);

  if (soleKey !== undefined) {
    const child = node[soleKey];

    if (isNode(child)) {
      walk(child, visit, contract);
    }
    return;
  }

  for (const [key, value] of Object.entries(node)) {
    if (
      SKIPPED_KEYS.has(key) ||
      key === "parent" ||
      (key === "id" && node.type === "FunctionExpression")
    ) {
      continue;
    }
    const nested = contract || CONTRACT_TYPES.has(node.type);

    if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) {
          walk(item, visit, nested);
        }
      }
    } else if (isNode(value)) {
      walk(value, visit, nested);
    }
  }
};

const isPlainFunction = (node: unknown): node is NodeLike =>
  isNode(node) && (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression");

const EFFECT_FN_MEMBERS = new Set(["fn", "fnUntraced"]);

// `Effect.fn("span")(function* () {})` keeps its body inside a CallExpression, so a wrapped
// helper never looks like a bare function value. Walk past the optional span-name call to
// reach `Effect.fn` itself.
const isEffectFnCallee = (callee: unknown): boolean => {
  if (!isNode(callee)) {
    return false;
  }
  if (callee.type === "CallExpression") {
    return isEffectFnCallee(callee.callee);
  }
  if (callee.type !== "MemberExpression") {
    return false;
  }

  const { object, property } = callee;

  return (
    isNode(object) &&
    isString(object.name) &&
    object.name === "Effect" &&
    isNode(property) &&
    isString(property.name) &&
    EFFECT_FN_MEMBERS.has(property.name)
  );
};

const isEffectFnValue = (node: unknown): node is NodeLike =>
  isNode(node) &&
  node.type === "CallExpression" &&
  isEffectFnCallee(node.callee) &&
  Array.isArray(node.arguments) &&
  node.arguments.some(isPlainFunction);

const isFunctionValue = (node: unknown): node is NodeLike =>
  isPlainFunction(node) || isEffectFnValue(node);

const CONSTANT_LITERALS = new Set(["ArrayExpression", "ObjectExpression"]);
const TYPE_WRAPPERS = new Set(["TSAsExpression", "TSSatisfiesExpression"]);
const COMPUTED_VALUES = new Set(["CallExpression", "NewExpression", "TaggedTemplateExpression"]);

const unwrapTypeAssertions = (node: NodeLike): NodeLike =>
  TYPE_WRAPPERS.has(node.type) && isNode(node.expression)
    ? unwrapTypeAssertions(node.expression)
    : node;

const computesValue = (node: NodeLike) => {
  let computes = false;
  walk(node, (child) => {
    computes ||= COMPUTED_VALUES.has(child.type);
  });
  return computes;
};

const isEmptyLiteral = (node: NodeLike) =>
  (Array.isArray(node.elements) && node.elements.length === 0) ||
  (Array.isArray(node.properties) && node.properties.length === 0);

// A plain object or array literal named once is a lookup the reader has to jump to; inlined,
// it reads where it is used. A literal that builds values (a formatter, a regular expression)
// or an empty sentinel keeps its name: its single construction or its identity is the point.
const isConstantValue = (node: unknown): node is NodeLike => {
  if (!isNode(node)) {
    return false;
  }
  const literal = unwrapTypeAssertions(node);
  return CONSTANT_LITERALS.has(literal.type) && !isEmptyLiteral(literal) && !computesValue(literal);
};

const isTopLevelValue = (node: unknown): node is NodeLike =>
  isFunctionValue(node) || isConstantValue(node);

const isTypeKind = (candidate: Candidate | undefined) =>
  candidate !== undefined && (candidate.kind === "interface" || candidate.kind === "type alias");

// A `value is T` signature cannot survive inlining: the narrowing lives in the annotation,
// not the expression, so the call site would silently fall back to `boolean`.
const isTypePredicate = (fn: unknown) => {
  if (!isNode(fn)) {
    return false;
  }
  const { returnType } = fn;
  if (!isNode(returnType)) {
    return false;
  }
  const annotation = returnType.typeAnnotation;

  return isNode(annotation) && annotation.type === "TSTypePredicate";
};

const counters = (declaration: Span, exported: boolean, scope: NodeLike) => ({
  contractReferences: 0,
  declarationEnd: spanEnd(declaration),
  declarationStart: spanStart(declaration),
  exported,
  exposed: false,
  nested: scope.type !== "Program",
  positions: new Array<number>(),
  repeated: false,
  references: 0,
  scopeEnd: spanEnd(scope),
  scopeStart: spanStart(scope),
  selfReferences: 0,
});

// A port contract is declared in one of two standard ways: as the type argument of
// `Context.Tag("…")<Tag, ServiceApi>()`, `Context.GenericTag`, or `Effect.Service<Self>()`, or
// as the target of a `satisfies ServiceApi` implementation. What they name, and the vocabulary
// reachable from it, is the port's public contract, so it keeps its name even when one file
// holds the only reference.
const PORT_CONTRACT_CALLEES = new Set(["GenericTag", "Service", "Tag"]);

const CALLABLE_MEMBERS = new Set(["TSCallSignatureDeclaration", "TSConstructSignatureDeclaration"]);

/**
 * Declarations that other type rules need to stay named. A generic interface fights
 * `no-unnecessary-type-parameters` once inlined, and an overload set inlines into the
 * anonymous target that `no-known-value-widening` rejects.
 */
const isUninlinableInterface = (declaration: ESTree.Node) => {
  if (declaration.type !== "TSInterfaceDeclaration") {
    return false;
  }
  if (declaration.typeParameters) {
    return true;
  }

  const members = declaration.body.body;

  return members.length > 0 && members.every((member) => CALLABLE_MEMBERS.has(member.type));
};

const calleeTail = (callee: unknown): string | null => {
  if (!isNode(callee)) {
    return null;
  }
  if (callee.type === "CallExpression") {
    return calleeTail(callee.callee);
  }
  if (callee.type === "MemberExpression") {
    const { property } = callee;

    return isNode(property) && isString(property.name) ? property.name : null;
  }

  return isString(callee.name) ? callee.name : null;
};

const typeReferenceNames = (typeArguments: unknown, names: Set<string>) => {
  if (!isNode(typeArguments)) {
    return;
  }
  walk(typeArguments, (node) => {
    if (node.type !== "TSTypeReference") {
      return;
    }

    const { typeName } = node;

    if (isNode(typeName) && typeName.type === "Identifier" && isString(typeName.name)) {
      names.add(typeName.name);
    }
  });
};

const collectPortContractNames = (program: NodeLike) => {
  const names = new Set<string>();

  walk(program, (node) => {
    if (node.type === "TSSatisfiesExpression") {
      typeReferenceNames(node.typeAnnotation, names);
      return;
    }
    if (
      node.type === "CallExpression" &&
      PORT_CONTRACT_CALLEES.has(calleeTail(node.callee) ?? "")
    ) {
      typeReferenceNames(node.typeArguments, names);
    }
  });

  return names;
};

/**
 * Names that keep their own declaration: a port shape or a genuinely shared interface, plus
 * every interface whose references all sit inside one of those. Vocabulary hangs off a port
 * or a shared type; everything else earns its name by having more than one use.
 */
const exemptNames = (
  program: NodeLike,
  candidates: ReadonlyMap<string, Candidate>,
  filename: string,
) => {
  const exempt = new Set<string>();

  for (const name of collectPortContractNames(program)) {
    if (isTypeKind(candidates.get(name))) {
      exempt.add(name);
    }
  }
  for (const [name, candidate] of candidates) {
    if (isTypeKind(candidate) && candidate.exported && isImportedElsewhere(name, filename)) {
      exempt.add(name);
    }
  }

  const insideExempt = (position: number) => {
    for (const name of exempt) {
      const host = candidates.get(name);

      if (
        host !== undefined &&
        position >= host.declarationStart &&
        position < host.declarationEnd
      ) {
        return true;
      }
    }

    return false;
  };

  for (let pass = 0; pass < candidates.size; pass += 1) {
    let grew = false;

    for (const [name, candidate] of candidates) {
      if (
        isTypeKind(candidate) &&
        !exempt.has(name) &&
        candidate.positions.length > 0 &&
        candidate.positions.every(insideExempt)
      ) {
        exempt.add(name);
        grew = true;
      }
    }
    if (!grew) {
      break;
    }
  }

  return exempt;
};

const namedCandidate = (
  declaration: ESTree.Node,
  exported: boolean,
  scope: NodeLike,
): Candidate | null => {
  if (declaration.type === "TSInterfaceDeclaration") {
    return declaration.declare || isUninlinableInterface(declaration)
      ? null
      : {
          ...counters(declaration, exported, scope),
          id: declaration.id,
          kind: "interface" as const,
        };
  }
  if (declaration.type === "TSTypeAliasDeclaration") {
    return declaration.typeParameters
      ? null
      : {
          ...counters(declaration, exported, scope),
          id: declaration.id,
          kind: "type alias" as const,
        };
  }
  if (
    declaration.type === "FunctionDeclaration" &&
    declaration.id &&
    !isTypePredicate(declaration)
  ) {
    return {
      ...counters(declaration, exported, scope),
      id: declaration.id,
      kind: "helper" as const,
    };
  }

  return null;
};

const variableCandidates = (
  declaration: ESTree.VariableDeclaration,
  exported: boolean,
  scope: NodeLike,
  isCandidateValue: (init: unknown) => init is NodeLike,
) =>
  declaration.declarations.flatMap((declarator) =>
    declarator.id.type === "Identifier" &&
    isCandidateValue(declarator.init) &&
    !(isConstantValue(declarator.init) && declarator.id.typeAnnotation != null) &&
    !isTypePredicate(declarator.init)
      ? [
          {
            ...counters(declarator, exported, scope),
            id: declarator.id,
            kind: isConstantValue(declarator.init) ? ("constant" as const) : ("helper" as const),
          },
        ]
      : [],
  );

const isVariableDeclaration = (node: unknown): node is ESTree.VariableDeclaration =>
  isNode(node) && node.type === "VariableDeclaration";

// A helper declared inside a function body is scoped to that block. Only the `Effect.fn`
// shape is collected there: it is the one a service `make` uses for every method, so a
// single-use one is a private step that should live inside its only caller.
const collectNestedCandidates = (program: NodeLike) => {
  const nested = new Array<Candidate>();

  walk(program, (node) => {
    if (node.type !== "BlockStatement" || !Array.isArray(node.body)) {
      return;
    }
    for (const statement of node.body) {
      if (isVariableDeclaration(statement)) {
        nested.push(...variableCandidates(statement, false, node, isEffectFnValue));
      }
    }
  });

  return nested;
};

const markExportedSpecifiers = (
  program: ESTree.Program,
  candidates: ReadonlyMap<string, Candidate>,
) => {
  for (const statement of program.body) {
    if (statement.type !== "ExportNamedDeclaration" || statement.source) {
      continue;
    }
    for (const specifier of statement.specifiers) {
      const candidate =
        specifier.local.type === "Identifier" ? candidates.get(specifier.local.name) : undefined;

      if (candidate !== undefined) {
        candidate.exported = true;
      }
    }
  }
};

const collectCandidates = (program: ESTree.Program & NodeLike): Candidates => {
  const topLevel = new Map<string, Candidate>();

  for (const statement of program.body) {
    const exported = statement.type === "ExportNamedDeclaration";
    const declaration = exported ? statement.declaration : statement;

    if (!declaration) {
      continue;
    }
    if (declaration.type === "VariableDeclaration") {
      for (const candidate of variableCandidates(declaration, exported, program, isTopLevelValue)) {
        topLevel.set(candidate.id.name, candidate);
      }
      continue;
    }

    const candidate = namedCandidate(declaration, exported, program);

    if (candidate !== null) {
      topLevel.set(candidate.id.name, candidate);
    }
  }

  markExportedSpecifiers(program, topLevel);

  return { nested: collectNestedCandidates(program), topLevel };
};

// The innermost block that declares the name owns the reference; a nested helper shadows a
// top-level one of the same name inside its block.
const resolveCandidate = (candidates: Candidates, name: string, position: number) => {
  let innermost: Candidate | undefined;

  for (const candidate of candidates.nested) {
    if (
      candidate.id.name === name &&
      position >= candidate.scopeStart &&
      position < candidate.scopeEnd &&
      (innermost === undefined || candidate.scopeStart > innermost.scopeStart)
    ) {
      innermost = candidate;
    }
  }

  return innermost ?? candidates.topLevel.get(name);
};

const returnedValue = (node: NodeLike) => {
  if (node.type === "ReturnStatement") {
    return node.argument;
  }

  return node.type === "ArrowFunctionExpression" && node.expression === true
    ? node.body
    : undefined;
};

const returnedObject = (node: NodeLike): NodeLike | undefined => {
  const argument = returnedValue(node);

  return isNode(argument) && argument.type === "ObjectExpression" ? argument : undefined;
};

// A nested helper handed out through the returned object literal is the surface of the
// factory that built it, so that reference is an export rather than an inlinable call site.
const markExposedHelpers = (node: NodeLike, candidates: Candidates) => {
  const object = returnedObject(node);

  if (object === undefined || !Array.isArray(object.properties)) {
    return;
  }
  for (const property of object.properties) {
    if (!isNode(property) || property.type !== "Property" || property.computed === true) {
      continue;
    }

    const { value } = property;

    if (!isNode(value) || value.type !== "Identifier" || !isString(value.name)) {
      continue;
    }

    const candidate = resolveCandidate(candidates, value.name, spanStart(value));

    if (candidate !== undefined && candidate.nested) {
      candidate.exposed = true;
    }
  }
};

const countReferences = (program: NodeLike, candidates: Candidates) => {
  walk(program, (node, contract) => {
    markExposedHelpers(node, candidates);

    if (node.type !== "Identifier" || !isString(node.name)) {
      return;
    }

    const position = spanStart(node);
    const candidate = resolveCandidate(candidates, node.name, position);

    if (candidate === undefined) {
      return;
    }

    if (position === spanStart(candidate.id)) {
      return;
    }
    if (position >= candidate.declarationStart && position < candidate.declarationEnd) {
      candidate.selfReferences += 1;
      return;
    }
    if (contract) {
      candidate.contractReferences += 1;
      return;
    }
    candidate.positions.push(position);
    candidate.references += 1;
    candidate.repeated ||= isRepeatedlyEvaluated(node) || isTypeQueried(node);
  });
};

const LOOPS = new Set([
  "DoWhileStatement",
  "ForInStatement",
  "ForOfStatement",
  "ForStatement",
  "WhileStatement",
]);
const ITERATION_METHODS = new Set([
  "every",
  "filter",
  "find",
  "findIndex",
  "flatMap",
  "forEach",
  "from",
  "map",
  "reduce",
  "some",
]);
const FUNCTIONS = new Set(["ArrowFunctionExpression", "FunctionExpression"]);

const isIterationCallback = (fn: NodeLike) => {
  const call = fn.parent;
  if (!isNode(call) || call.type !== "CallExpression" || !isNode(call.callee)) {
    return false;
  }
  const { property } = call.callee;
  return isNode(property) && isString(property.name) && ITERATION_METHODS.has(property.name);
};

// A constant read in a loop, an iteration callback, or a default parameter is built once on
// purpose: inlined, the literal would be rebuilt on every pass or every call.
const isRepeatedlyEvaluated = (reference: NodeLike) => {
  let child = reference;
  let current = reference.parent;
  while (isNode(current) && current.type !== "Program") {
    if (LOOPS.has(current.type) && (current.body === child || current.right === child)) {
      return true;
    }
    if (FUNCTIONS.has(current.type) && isIterationCallback(current)) {
      return true;
    }
    if (current.type === "AssignmentPattern" && current.right === child) {
      return true;
    }
    child = current;
    current = current.parent;
  }
  return false;
};

const isTypeQueried = (reference: NodeLike) =>
  isNode(reference.parent) && reference.parent.type === "TSTypeQuery";

const isReportable = (candidate: Candidate, name: string, filename: string) =>
  candidate.references === 1 &&
  candidate.selfReferences === 0 &&
  candidate.contractReferences === 0 &&
  !candidate.exposed &&
  !(candidate.kind === "constant" && candidate.repeated) &&
  !(candidate.exported && isImportedElsewhere(name, filename));

const candidateMessageId = (candidate: Candidate) => {
  if (candidate.kind === "helper") {
    return "singleUseHelper";
  }
  if (candidate.kind === "constant") {
    return "singleUseConstant";
  }
  return candidate.kind === "interface" ? "singleUseInterface" : "singleUseTypeAlias";
};

const noSingleUseHelpers = defineRule({
  create: (context) => {
    const [option] = context.options;
    const checkFunctions =
      !isObject(option) || !("checkFunctions" in option) || option.checkFunctions !== false;
    const checkConstants =
      !isObject(option) || !("checkConstants" in option) || option.checkConstants !== false;
    const checksKind = (candidate: Candidate) => {
      if (candidate.kind === "helper") {
        return checkFunctions;
      }
      if (candidate.kind === "constant") {
        return checkConstants;
      }
      return true;
    };

    return {
      Program: (program: ESTree.Program) => {
        if (!isNode(program)) {
          return;
        }

        const candidates = collectCandidates(program);

        if (candidates.topLevel.size === 0 && candidates.nested.length === 0) {
          return;
        }

        countReferences(program, candidates);

        const exempt = exemptNames(program, candidates.topLevel, context.filename);
        const report = (candidate: Candidate) => {
          context.report({
            data: { name: candidate.id.name },
            messageId: candidateMessageId(candidate),
            node: candidate.id,
          });
        };

        for (const [name, candidate] of candidates.topLevel) {
          if (
            checksKind(candidate) &&
            !exempt.has(name) &&
            isReportable(candidate, name, context.filename)
          ) {
            report(candidate);
          }
        }
        if (checkFunctions) {
          for (const candidate of candidates.nested) {
            if (isReportable(candidate, candidate.id.name, context.filename)) {
              report(candidate);
            }
          }
        }
      },
    };
  },
  meta: {
    docs: {
      description:
        "Disallow top-level helpers, object and array constants, interfaces, and type aliases that are referenced only once in the same file and imported by no other file, and `Effect.fn` helpers declared inside a function body that only one call site uses; inline them instead.",
    },
    messages: {
      singleUseConstant:
        "Constant '{{name}}' is only used once. Inline the object or array at its single use; keep a named constant for values shared by multiple call sites.",
      singleUseHelper:
        "Helper '{{name}}' is only used once. Inline it at the call site; keep top-level helpers for logic shared by multiple call sites.",
      singleUseInterface:
        "Interface '{{name}}' is only used once and no other file imports it. Inline the object type at its single use; 'export' alone does not make it shared.",
      singleUseTypeAlias:
        "Type alias '{{name}}' is only used once and no other file imports it. Inline the type at its single use; 'export' alone does not make it shared.",
    },
    schema: [
      {
        additionalProperties: false,
        properties: {
          checkConstants: { type: "boolean" },
          checkFunctions: { type: "boolean" },
        },
        type: "object",
      },
    ],
    type: "suggestion",
  },
});

export default definePlugin({
  meta: { name: "helper-policy" },
  rules: { "no-single-use-helpers": noSingleUseHelpers },
});
