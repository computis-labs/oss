import { definePlugin, defineRule } from "@oxlint/plugins";

import {
  bareExpression,
  columnBuilderCall,
  elementOfType,
  enumColumnsOfTable,
  enumOwnerOfPgEnum,
  enumOwnerOfType,
  membersOfType,
  propertyName,
  resolveValue,
} from "./enum-declarations.ts";

import { isString } from "./predicates.ts";

import type { EnumOwner, SourceModule, TypeReference } from "./enum-declarations.ts";
import type { ESTree } from "@oxlint/plugins";

/** Drizzle comparison helpers whose first argument is a column reference. */
const COLUMN_PREDICATES = new Set([
  "arrayContained",
  "arrayContains",
  "arrayOverlaps",
  "eq",
  "inArray",
  "ne",
  "notInArray",
]);

const WRITE_METHODS = new Set(["set", "values"]);
const TABLE_METHODS = new Set(["insert", "update"]);
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;
const MAX_VALUE_DEPTH = 6;

type FunctionNode = ESTree.ArrowFunctionExpression | ESTree.Function;

const isFunction = (node: ESTree.Node): node is FunctionNode =>
  node.type === "ArrowFunctionExpression" ||
  node.type === "FunctionDeclaration" ||
  node.type === "FunctionExpression";

const isStringLiteral = (node: ESTree.Node): node is ESTree.StringLiteral =>
  node.type === "Literal" && isString(node.value);

const stringLiteral = (node: ESTree.Node | null) => {
  const value = bareExpression(node);
  return value !== null && isStringLiteral(value) ? value : null;
};

/** Builds `owner.key`, falling back to bracket access for non-identifier keys. */
const accessorFor = (owner: EnumOwner, member: string) => {
  let accessor = owner.name;

  for (const segment of member.split(".")) {
    accessor = IDENTIFIER.test(segment)
      ? `${accessor}.${segment}`
      : `${accessor}[${JSON.stringify(segment)}]`;
  }

  return accessor;
};

/** Declared type of a parameter, whether or not it carries a default. */
const parameterAnnotation = (
  parameter: ESTree.Node | undefined,
): ESTree.TSType | ESTree.TSTypeAnnotation | null => {
  if (parameter === undefined) {
    return null;
  }

  const target = parameter.type === "AssignmentPattern" ? parameter.left : parameter;
  if (!("typeAnnotation" in target)) {
    return null;
  }

  return target.typeAnnotation ?? null;
};

/** The function a resolved binding stands for, direct or assigned to a name. */
const functionOf = (declaration: ESTree.Node) => {
  if (isFunction(declaration)) {
    return declaration;
  }
  if (declaration.type !== "VariableDeclarator") {
    return null;
  }

  const initializer = bareExpression(declaration.init);
  return initializer !== null && isFunction(initializer) ? initializer : null;
};

/** Walks `db.update(table).set(...)` back to the table identifier. */
const tableOfWriteChain = (node: ESTree.CallExpression): string | null => {
  let receiver: ESTree.Node | null =
    node.callee.type === "MemberExpression" ? node.callee.object : null;

  while (receiver !== null && receiver.type === "CallExpression") {
    // Annotated so the loop does not infer `receiver` from its own assignment.
    const callee: ESTree.Node = receiver.callee;
    if (callee.type !== "MemberExpression") {
      return null;
    }

    if (callee.property.type === "Identifier" && TABLE_METHODS.has(callee.property.name)) {
      const [table] = receiver.arguments;
      return table?.type === "Identifier" ? table.name : null;
    }

    receiver = callee.object;
  }

  return null;
};

/** Column referenced by `table.column`, when the receiver is a plain identifier. */
const columnReference = (
  node: ESTree.Node | undefined,
): { readonly column: string; readonly table: string } | null => {
  if (node?.type !== "MemberExpression" || node.computed) {
    return null;
  }
  if (node.object.type !== "Identifier" || node.property.type !== "Identifier") {
    return null;
  }

  return { column: node.property.name, table: node.object.name };
};

const noHardcodedEnumValues = defineRule({
  create: (context) => {
    // The linted file uses the live AST, so `--fix` passes never read a stale cache.
    const module: SourceModule = { ast: context.sourceCode.ast, path: context.filename };

    /** True when `owner.name` already resolves to the declaring module in this file. */
    const ownerInScope = (owner: EnumOwner) =>
      resolveValue(module, owner.name)?.module.path === owner.path;

    const report = (node: ESTree.StringLiteral, owner: EnumOwner) => {
      const member = owner.members.get(node.value);
      if (member === undefined) {
        return;
      }

      const accessor = accessorFor(owner, member);
      const inScope = ownerInScope(owner);

      context.report({
        data: { accessor, literal: node.value, owner: owner.name },
        fix: inScope ? (fixer) => fixer.replaceText(node, accessor) : undefined,
        messageId: inScope ? "useConstant" : "useConstantAndImport",
        node,
      });
    };

    const reportLiteral = (node: ESTree.Node | null, owner: EnumOwner | null) => {
      const literal = stringLiteral(node);
      if (literal !== null && owner !== null) {
        report(literal, owner);
      }
    };

    /** Descends a value against its declared type, reporting literals in enum slots. */
    const checkValue = (value: ESTree.Node | null, type: TypeReference | null, depth = 0): void => {
      const node = bareExpression(value);
      if (node === null || type === null || depth > MAX_VALUE_DEPTH) {
        return;
      }

      const literal = stringLiteral(node);
      if (literal !== null) {
        reportLiteral(literal, enumOwnerOfType(type.type, type.module));
        return;
      }

      if (node.type === "ObjectExpression") {
        const members = membersOfType(type.type, type.module);
        if (members === null) {
          return;
        }

        for (const property of node.properties) {
          if (property.type !== "Property" || property.computed) {
            continue;
          }

          const key = propertyName(property.key);
          const member = key === null ? undefined : members.get(key);
          if (member !== undefined) {
            checkValue(property.value, member, depth + 1);
          }
        }
        return;
      }

      if (node.type !== "ArrayExpression") {
        return;
      }

      const element = elementOfType(type.type, type.module);
      if (element === null) {
        return;
      }

      for (const item of node.elements) {
        checkValue(item, element, depth + 1);
      }
    };

    /** Reports literals written to enum-backed Drizzle columns. */
    const checkColumnObject = (
      value: ESTree.Node | null,
      columns: ReadonlyMap<string, EnumOwner>,
    ): void => {
      const object = bareExpression(value);

      if (object?.type === "ArrayExpression") {
        for (const item of object.elements) {
          checkColumnObject(item, columns);
        }
        return;
      }

      if (object?.type !== "ObjectExpression") {
        return;
      }

      for (const property of object.properties) {
        if (property.type !== "Property" || property.computed) {
          continue;
        }

        const key = propertyName(property.key);
        const owner = key === null ? undefined : columns.get(key);
        reportLiteral(property.value, owner ?? null);
      }
    };

    /** `eq(table.column, "literal")` and the other column predicates. */
    const checkColumnPredicate = (node: ESTree.CallExpression) => {
      const reference = columnReference(node.arguments[0]);
      if (reference === null) {
        return;
      }

      const owner = enumColumnsOfTable(module, reference.table)?.get(reference.column);
      if (owner === undefined) {
        return;
      }

      const [, value] = node.arguments;
      const candidates = value?.type === "ArrayExpression" ? value.elements : [value ?? null];
      for (const candidate of candidates) {
        reportLiteral(candidate, owner);
      }
    };

    /** `enumColumn("name").default("literal")` inside a Drizzle schema. */
    const checkColumnDefault = (node: ESTree.CallExpression, receiver: ESTree.Node) => {
      const builder = columnBuilderCall(bareExpression(receiver));
      if (builder === null || builder.callee.type !== "Identifier") {
        return;
      }

      const declaration = resolveValue(module, builder.callee.name);
      const owner =
        declaration === null ? null : enumOwnerOfPgEnum(declaration.node, declaration.module);
      reportLiteral(node.arguments[0] ?? null, owner);
    };

    /** Arguments of a call whose callee resolves to an annotated function. */
    const checkCallArguments = (node: ESTree.CallExpression) => {
      if (node.callee.type !== "Identifier") {
        return;
      }

      const resolved = resolveValue(module, node.callee.name);
      const fn = resolved === null ? null : functionOf(resolved.node);
      if (fn === null || resolved === null) {
        return;
      }

      for (const [index, argument] of node.arguments.entries()) {
        const annotation = parameterAnnotation(fn.params[index]);
        if (annotation !== null) {
          checkValue(argument, { module: resolved.module, type: annotation });
        }
      }
    };

    return {
      ArrowFunctionExpression: (node: ESTree.ArrowFunctionExpression) => {
        const returnType = node.returnType ?? null;
        if (returnType !== null && node.body.type !== "BlockStatement") {
          checkValue(node.body, { module, type: returnType });
        }
      },

      AssignmentPattern: (node: ESTree.AssignmentPattern) => {
        const annotation = parameterAnnotation(node);
        if (annotation !== null) {
          checkValue(node.right, { module, type: annotation });
        }
      },

      CallExpression: (node: ESTree.CallExpression) => {
        const { callee } = node;

        if (callee.type === "Identifier") {
          if (COLUMN_PREDICATES.has(callee.name)) {
            checkColumnPredicate(node);
          }
          checkCallArguments(node);
          return;
        }

        if (callee.type !== "MemberExpression" || callee.property.type !== "Identifier") {
          return;
        }

        if (WRITE_METHODS.has(callee.property.name)) {
          const table = tableOfWriteChain(node);
          const columns = table === null ? null : enumColumnsOfTable(module, table);
          if (columns !== null) {
            checkColumnObject(node.arguments[0] ?? null, columns);
          }
        }

        if (callee.property.name === "default") {
          checkColumnDefault(node, callee.object);
        }
      },

      ReturnStatement: (node: ESTree.ReturnStatement) => {
        if (node.argument === null) {
          return;
        }

        let enclosing: ESTree.Node | null = node.parent;
        while (enclosing !== null && !isFunction(enclosing)) {
          enclosing = "parent" in enclosing ? enclosing.parent : null;
        }

        const returnType = enclosing === null ? null : (enclosing.returnType ?? null);
        if (returnType !== null) {
          checkValue(node.argument, { module, type: returnType });
        }
      },

      VariableDeclarator: (node: ESTree.VariableDeclarator) => {
        const annotation = node.id.type === "Identifier" ? (node.id.typeAnnotation ?? null) : null;
        if (annotation !== null && node.init !== null) {
          checkValue(node.init, { module, type: annotation });
        }
      },
    };
  },
  meta: {
    docs: {
      description:
        "Disallow raw string literals in positions whose declared type is a literal union backed by a named constant object. Use the constant so domain values stay searchable and refactorable.",
    },
    fixable: "code",
    messages: {
      useConstant:
        'Do not hardcode "{{literal}}". Use {{accessor}} instead, so the value stays tied to {{owner}}.',
      useConstantAndImport:
        'Do not hardcode "{{literal}}". Import {{owner}} and use {{accessor}} instead.',
    },
    schema: [],
    type: "problem",
  },
});

export default definePlugin({
  meta: { name: "enum-value-policy" },
  rules: { "no-hardcoded-enum-values": noHardcodedEnumValues },
});
