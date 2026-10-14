import { definePlugin, defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";
import { isNumber, isObject, isString } from "./predicates.ts";

type FunctionNode = ESTree.ArrowFunctionExpression | ESTree.Function;
type NodeLike = { type: string } & Record<string, unknown>;
type TypeEnvironment = ReadonlyMap<string, ReadonlySet<string>>;

const EMPTY_TYPE_ENVIRONMENT: TypeEnvironment = new Map();

const KEYWORD_CATEGORIES = new Map([
  ["TSBigIntKeyword", "bigint"],
  ["TSBooleanKeyword", "boolean"],
  ["TSNeverKeyword", "never"],
  ["TSNullKeyword", "null"],
  ["TSNumberKeyword", "number"],
  ["TSObjectKeyword", "object"],
  ["TSStringKeyword", "string"],
  ["TSSymbolKeyword", "symbol"],
  ["TSUndefinedKeyword", "undefined"],
  ["TSVoidKeyword", "undefined"],
]);

const NESTED_SCOPE_TYPES = new Set([
  "ArrowFunctionExpression",
  "ClassDeclaration",
  "ClassExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

const BOOLEAN_BINARY_OPERATORS = new Set([
  "!=",
  "!==",
  "<",
  "<=",
  "==",
  "===",
  ">",
  ">=",
  "in",
  "instanceof",
]);

const NUMBER_BINARY_OPERATORS = new Set([
  "%",
  "*",
  "**",
  "-",
  "/",
  "<<",
  ">>",
  ">>>",
  "&",
  "^",
  "|",
]);

const isNode = (value: unknown): value is NodeLike =>
  isObject(value) && isString(Reflect.get(value, "type"));

const addAll = (target: Set<string>, source: ReadonlySet<string>) => {
  for (const category of source) {
    target.add(category);
  }
};

const identifierName = (value: unknown) =>
  isNode(value) && value.type === "Identifier" && isString(value.name) ? value.name : undefined;

const SIMPLE_INSTANCE_TYPES = new Set([
  "Date",
  "Map",
  "ReadonlyMap",
  "ReadonlySet",
  "Set",
  "WeakMap",
  "WeakSet",
]);

const SIMPLE_TYPE_REFERENCES = new Set([
  "Array",
  "Date",
  "Map",
  "Promise",
  "PromiseLike",
  "ReadonlyArray",
  "ReadonlyMap",
  "ReadonlySet",
  "Set",
  "WeakMap",
  "WeakSet",
]);

const SIMPLE_TYPE_NODE_TYPES = new Set(["TSConstructorType", "TSFunctionType", "TSTypeLiteral"]);

const literalCategories = (value: unknown) => {
  const categories = new Set<string>();
  if (!isNode(value) || value.type !== "Literal") {
    return categories;
  }
  if (value.value === null) {
    categories.add("null");
  } else if (isString(value.value)) {
    categories.add("string");
  } else if (isNumber(value.value)) {
    categories.add("number");
  } else if (value.value === true || value.value === false) {
    categories.add("boolean");
  } else if (isString(value.bigint)) {
    categories.add("bigint");
  }
  return categories;
};

const orderedStrings = (values: readonly string[]) => {
  const ordered: string[] = [];
  for (const value of values) {
    const index = ordered.findIndex((candidate) => candidate > value);
    ordered.splice(index === -1 ? ordered.length : index, 0, value);
  }
  return ordered;
};

const typeReferenceCategories = (
  value: NodeLike,
  resolve: (value: unknown) => ReadonlySet<string>,
) => {
  const categories = new Set<string>();
  const name = identifierName(value.typeName);
  const { typeArguments } = value;
  const parameters: readonly unknown[] =
    isNode(typeArguments) && Array.isArray(typeArguments.params) ? typeArguments.params : [];
  const [parameter] = parameters;

  if (name === "Array" || name === "ReadonlyArray") {
    categories.add("array");
  } else if (name === "Promise" || name === "PromiseLike") {
    addAll(categories, resolve(parameter));
  } else if (name !== undefined && SIMPLE_INSTANCE_TYPES.has(name)) {
    categories.add(`instance:${name}`);
  }
  return categories;
};

const typeLiteralCategories = (value: NodeLike) => {
  const members = Array.isArray(value.members) ? value.members : [];
  const keys = members.flatMap((member) => {
    if (!isNode(member)) {
      return [];
    }
    const { key } = member;
    if (!isNode(key)) {
      return [];
    }
    if (isString(key.name)) {
      return [key.name];
    }
    return isString(key.value) || isNumber(key.value) ? [String(key.value)] : [];
  });
  return new Set([`object:{${orderedStrings(keys).join(",")}}`]);
};

const typeCategory = (value: unknown) => {
  const categories = new Set<string>();
  if (!isNode(value)) {
    return categories;
  }

  const keyword = KEYWORD_CATEGORIES.get(value.type);
  if (keyword !== undefined) {
    categories.add(keyword);
  } else if (value.type === "TSArrayType" || value.type === "TSTupleType") {
    categories.add("array");
  } else if (value.type === "TSTypeReference") {
    addAll(categories, typeReferenceCategories(value, typeCategory));
  } else if (value.type === "TSFunctionType" || value.type === "TSConstructorType") {
    categories.add("function");
  } else if (value.type === "TSTypeLiteral") {
    addAll(categories, typeLiteralCategories(value));
  } else if (value.type === "TSUnionType" && Array.isArray(value.types)) {
    for (const member of value.types) {
      addAll(categories, typeCategory(member));
    }
  } else if (value.type === "TSLiteralType") {
    addAll(categories, literalCategories(value.literal));
  }

  return categories;
};

const isFullySimpleType = (value: unknown): boolean => {
  if (!isNode(value)) {
    return false;
  }
  if (value.type === "TSTypeAnnotation") {
    return isFullySimpleType(value.typeAnnotation);
  }
  if (KEYWORD_CATEGORIES.has(value.type) || SIMPLE_TYPE_NODE_TYPES.has(value.type)) {
    return true;
  }
  if (value.type === "TSArrayType") {
    return isFullySimpleType(value.elementType);
  }
  if (value.type === "TSTupleType") {
    return Array.isArray(value.elementTypes) && value.elementTypes.every(isFullySimpleType);
  }
  if (value.type === "TSUnionType") {
    return Array.isArray(value.types) && value.types.every(isFullySimpleType);
  }
  if (value.type === "TSLiteralType") {
    return literalCategories(value.literal).size > 0;
  }
  if (value.type !== "TSTypeReference") {
    return false;
  }

  const name = identifierName(value.typeName);
  if (name === undefined || !SIMPLE_TYPE_REFERENCES.has(name)) {
    return false;
  }
  const { typeArguments } = value;
  const parameters: readonly unknown[] =
    isNode(typeArguments) && Array.isArray(typeArguments.params) ? typeArguments.params : [];
  return parameters.every(isFullySimpleType);
};

const objectCategory = (value: NodeLike) => {
  const properties = Array.isArray(value.properties) ? value.properties : [];
  const keys: string[] = [];

  for (const property of properties) {
    if (!isNode(property) || property.type !== "Property" || property.computed === true) {
      return new Set(["object"]);
    }
    const { key } = property;
    if (!isNode(key)) {
      return new Set(["object"]);
    }
    if (isString(key.name)) {
      keys.push(key.name);
      continue;
    }
    if (isString(key.value) || isNumber(key.value)) {
      keys.push(String(key.value));
      continue;
    }
    return new Set(["object"]);
  }

  return new Set([`object:{${orderedStrings(keys).join(",")}}`]);
};

type ExpressionResolver = (value: unknown, environment?: TypeEnvironment) => Set<string>;

const STATIC_EXPRESSION_CATEGORIES = new Map([
  ["ArrayExpression", "array"],
  ["ArrowFunctionExpression", "function"],
  ["ClassExpression", "class"],
  ["FunctionExpression", "function"],
  ["JSXElement", "jsx"],
  ["JSXFragment", "jsx"],
  ["TemplateLiteral", "string"],
]);

const TRANSPARENT_EXPRESSION_TYPES = new Set([
  "AwaitExpression",
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

const TYPE_ANNOTATED_EXPRESSION_TYPES = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

const CALL_CATEGORIES = new Map([
  ["Boolean", "boolean"],
  ["Number", "number"],
  ["String", "string"],
]);

const PREDICATE_CATEGORIES = new Map([["isString", "string"]]);

const UNARY_CATEGORIES = new Map([
  ["!", "boolean"],
  ["+", "number"],
  ["-", "number"],
  ["typeof", "string"],
  ["void", "undefined"],
  ["~", "number"],
]);

const staticExpressionCategories = (value: NodeLike): Set<string> | null => {
  if (value.type === "Literal") {
    return literalCategories(value);
  }
  if (value.type === "ObjectExpression") {
    return objectCategory(value);
  }

  const category = STATIC_EXPRESSION_CATEGORIES.get(value.type);
  return category === undefined ? null : new Set([category]);
};

const branchExpressionCategories = (
  value: NodeLike,
  environment: TypeEnvironment,
  resolve: ExpressionResolver,
): Set<string> | null => {
  const categories = new Set<string>();
  if (value.type === "ConditionalExpression") {
    const test = isNode(value.test) ? value.test : null;
    const predicateName = test?.type === "CallExpression" ? identifierName(test.callee) : undefined;
    const predicateCategory =
      predicateName === undefined ? undefined : PREDICATE_CATEGORIES.get(predicateName);
    const arguments_: readonly unknown[] =
      test?.type === "CallExpression" && Array.isArray(test.arguments) ? test.arguments : [];
    const [argument] = arguments_;
    const argumentName = identifierName(argument);
    const consequentEnvironment =
      predicateCategory === undefined || argumentName === undefined
        ? environment
        : new Map(environment).set(argumentName, new Set([predicateCategory]));

    addAll(categories, resolve(value.consequent, consequentEnvironment));
    addAll(categories, resolve(value.alternate, environment));
    return categories;
  }
  if (value.type !== "LogicalExpression") {
    return null;
  }

  const left = resolve(value.left, environment);
  const right = resolve(value.right, environment);
  if (value.operator === "??") {
    const unresolvedLeft = left.size === 0;
    left.delete("null");
    left.delete("undefined");
    if (unresolvedLeft && (right.has("null") || right.has("undefined"))) {
      left.add("unresolved");
    }
  }
  addAll(categories, left);
  addAll(categories, right);
  return categories;
};

const wrappedExpressionCategories = (
  value: NodeLike,
  environment: TypeEnvironment,
  resolve: ExpressionResolver,
): Set<string> | null => {
  const categories = new Set<string>();
  if (TRANSPARENT_EXPRESSION_TYPES.has(value.type)) {
    if (TYPE_ANNOTATED_EXPRESSION_TYPES.has(value.type)) {
      const annotated = typeCategory(value.typeAnnotation);
      if (annotated.size > 0) {
        return annotated;
      }
    }
    addAll(categories, resolve(value.expression, environment));
    return categories;
  }
  if (value.type === "AssignmentExpression") {
    addAll(categories, resolve(value.right, environment));
    return categories;
  }
  if (value.type === "SequenceExpression" && Array.isArray(value.expressions)) {
    addAll(categories, resolve(value.expressions.at(-1), environment));
    return categories;
  }
  return null;
};

const binaryExpressionCategories = (
  value: NodeLike,
  environment: TypeEnvironment,
  resolve: ExpressionResolver,
) => {
  const categories = new Set<string>();
  if (!isString(value.operator)) {
    return categories;
  }
  if (BOOLEAN_BINARY_OPERATORS.has(value.operator)) {
    categories.add("boolean");
  } else if (NUMBER_BINARY_OPERATORS.has(value.operator)) {
    categories.add("number");
  } else if (value.operator === "+") {
    const left = resolve(value.left, environment);
    const right = resolve(value.right, environment);
    if (left.has("string") || right.has("string")) {
      categories.add("string");
    } else if (left.has("number") && right.has("number")) {
      categories.add("number");
    }
  }
  return categories;
};

const operatorExpressionCategories = (
  value: NodeLike,
  environment: TypeEnvironment,
  resolve: ExpressionResolver,
): Set<string> | null => {
  if (value.type === "UnaryExpression" && isString(value.operator)) {
    const category = UNARY_CATEGORIES.get(value.operator);
    return category === undefined ? new Set<string>() : new Set([category]);
  }
  if (value.type === "UpdateExpression") {
    return new Set(["number"]);
  }
  return value.type === "BinaryExpression"
    ? binaryExpressionCategories(value, environment, resolve)
    : null;
};

const referenceExpressionCategories = (
  value: NodeLike,
  environment: TypeEnvironment,
): Set<string> | null => {
  const categories = new Set<string>();
  if (value.type === "Identifier") {
    const { name } = value;
    if (name === "undefined") {
      categories.add("undefined");
    } else if (isString(name)) {
      addAll(categories, environment.get(name) ?? new Set());
    }
    return categories;
  }
  if (value.type === "CallExpression") {
    const name = identifierName(value.callee);
    const category = name === undefined ? undefined : CALL_CATEGORIES.get(name);
    if (category !== undefined) {
      categories.add(category);
    }
    return categories;
  }
  if (value.type === "NewExpression") {
    const name = identifierName(value.callee);
    if (name !== undefined) {
      categories.add(`instance:${name}`);
    }
    return categories;
  }
  return null;
};

const expressionCategories = (
  value: unknown,
  environment: TypeEnvironment = EMPTY_TYPE_ENVIRONMENT,
) => {
  if (!isNode(value)) {
    return new Set<string>();
  }
  return (
    staticExpressionCategories(value) ??
    branchExpressionCategories(value, environment, expressionCategories) ??
    wrappedExpressionCategories(value, environment, expressionCategories) ??
    operatorExpressionCategories(value, environment, expressionCategories) ??
    referenceExpressionCategories(value, environment) ??
    new Set<string>()
  );
};

const annotationCategories = (value: unknown) => {
  if (!isNode(value)) {
    return new Set<string>();
  }
  return value.type === "TSTypeAnnotation"
    ? typeCategory(value.typeAnnotation)
    : typeCategory(value);
};

const functionEnvironment = (node: FunctionNode) => {
  const environment = new Map<string, Set<string>>();
  const bindings: {
    readonly annotation: unknown;
    readonly name: string;
    readonly value: unknown;
  }[] = [];

  const addBinding = (pattern: unknown, value: unknown) => {
    if (!isNode(pattern)) {
      return;
    }
    if (pattern.type === "AssignmentPattern") {
      addBinding(pattern.left, pattern.right);
      return;
    }
    if (pattern.type === "RestElement") {
      addBinding(pattern.argument, value);
      return;
    }
    if (pattern.type === "Identifier" && isString(pattern.name)) {
      bindings.push({ annotation: pattern.typeAnnotation, name: pattern.name, value });
    }
  };

  for (const parameter of node.params) {
    addBinding(parameter, null);
  }

  const walk = (value: unknown) => {
    if (!isNode(value)) {
      return;
    }
    if (NESTED_SCOPE_TYPES.has(value.type)) {
      if (
        (value.type === "FunctionDeclaration" || value.type === "ClassDeclaration") &&
        isNode(value.id) &&
        value.id.type === "Identifier" &&
        isString(value.id.name)
      ) {
        environment.set(
          value.id.name,
          new Set([value.type === "ClassDeclaration" ? "class" : "function"]),
        );
      }
      return;
    }
    if (value.type === "VariableDeclarator") {
      addBinding(value.id, value.init);
    } else if (value.type === "AssignmentExpression") {
      addBinding(value.left, value.right);
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === "parent") {
        continue;
      }
      if (Array.isArray(child)) {
        for (const item of child) {
          walk(item);
        }
      } else {
        walk(child);
      }
    }
  };

  if (node.body?.type === "BlockStatement") {
    walk(node.body);
  }

  for (let pass = 0; pass <= bindings.length; pass += 1) {
    let changed = false;
    for (const binding of bindings) {
      const annotated = annotationCategories(binding.annotation);
      const inferred =
        annotated.size > 0 ? annotated : expressionCategories(binding.value, environment);
      const current = environment.get(binding.name) ?? new Set<string>();
      const previousSize = current.size;
      addAll(current, inferred);
      environment.set(binding.name, current);
      changed ||= current.size !== previousSize;
    }
    if (!changed) {
      break;
    }
  }

  return environment;
};

const returnCategories = (node: FunctionNode) => {
  if (node.body === null) {
    return new Set<string>();
  }

  const environment = functionEnvironment(node);
  if (node.body.type !== "BlockStatement") {
    return expressionCategories(node.body, environment);
  }

  const categories = new Set<string>();
  const walk = (value: unknown) => {
    if (!isNode(value)) {
      return;
    }
    if (NESTED_SCOPE_TYPES.has(value.type)) {
      return;
    }
    if (value.type === "ReturnStatement") {
      if (value.argument === null || value.argument === undefined) {
        categories.add("undefined");
      } else {
        addAll(categories, expressionCategories(value.argument, environment));
      }
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === "parent") {
        continue;
      }
      if (Array.isArray(child)) {
        for (const item of child) {
          walk(item);
        }
      } else {
        walk(child);
      }
    }
  };

  for (const statement of node.body.body) {
    walk(statement);
  }
  return categories;
};

const categoryCount = (categories: ReadonlySet<string>) => {
  const normalized = new Set(categories);
  if (normalized.has("object")) {
    for (const category of normalized) {
      if (category.startsWith("object:{")) {
        normalized.delete(category);
      }
    }
  }
  return normalized.size;
};

const isTypePredicate = (node: FunctionNode) =>
  node.returnType?.typeAnnotation.type === "TSTypePredicate";

const cannotHaveReturnType = (node: FunctionNode) => {
  if (node.type !== "FunctionExpression") {
    return false;
  }

  const { parent } = node;
  return (
    (parent.type === "MethodDefinition" &&
      (parent.kind === "constructor" || parent.kind === "set")) ||
    (parent.type === "Property" && parent.kind === "set")
  );
};

const functionName = (node: FunctionNode): string | null => {
  const declaredName = identifierName(Reflect.get(node, "id"));
  if (declaredName !== undefined) {
    return declaredName;
  }

  const parent = Reflect.get(node, "parent");
  if (!isNode(parent)) {
    return null;
  }
  if (parent.type === "VariableDeclarator") {
    return identifierName(parent.id) ?? null;
  }
  if (parent.type === "AssignmentExpression") {
    return identifierName(parent.left) ?? null;
  }
  return null;
};

const isRecursive = (node: FunctionNode) => {
  const name = functionName(node);
  if (name === null || node.body === null) {
    return false;
  }

  let recursive = false;
  const walk = (value: unknown) => {
    if (recursive || !isNode(value)) {
      return;
    }
    if (
      value.type === "CallExpression" &&
      (identifierName(value.callee) === name ||
        (Array.isArray(value.arguments) &&
          value.arguments.some((argument) => identifierName(argument) === name)))
    ) {
      recursive = true;
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "parent") {
        continue;
      }
      if (Array.isArray(child)) {
        for (const item of child) {
          walk(item);
        }
      } else {
        walk(child);
      }
    }
  };

  walk(node.body);
  return recursive;
};

const returnTypesByBranch = defineRule({
  create: (context) => {
    const checkFunction = (node: FunctionNode) => {
      if (
        node.body === null ||
        node.generator ||
        cannotHaveReturnType(node) ||
        isTypePredicate(node)
      ) {
        return;
      }

      const needsContract = categoryCount(returnCategories(node)) > 1;
      if (needsContract && !node.returnType) {
        context.report({ messageId: "missing", node });
        return;
      }

      const { returnType } = node;
      const hasSimpleReturnType =
        returnType !== null &&
        isFullySimpleType(returnType) &&
        categoryCount(annotationCategories(returnType)) === 1;
      if (!needsContract && hasSimpleReturnType && returnType && !isRecursive(node)) {
        context.report({
          fix: (fixer) => fixer.remove(returnType),
          messageId: "unnecessary",
          node: returnType,
        });
      }
    };

    return {
      ArrowFunctionExpression: checkFunction,
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
    };
  },
  meta: {
    docs: {
      description:
        "Require explicit return types for different returned value categories and disallow simple inferred return annotations.",
    },
    fixable: "code",
    messages: {
      missing:
        "This function returns different value types. Add an explicit return type that defines their shared contract.",
      unnecessary:
        "This function returns one value type. Remove its simple return type and let TypeScript infer it.",
    },
    schema: [],
    type: "suggestion",
  },
});

export default definePlugin({
  meta: { name: "return-type-policy" },
  rules: { "by-branch": returnTypesByBranch },
});
