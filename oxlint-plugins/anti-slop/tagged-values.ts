import type { ESTree } from "@oxlint/plugins";

import { isString } from "../predicates.ts";

const equalityOperators = new Set(["==", "===", "!=", "!=="]);
const broadCatchMethods = new Set(["catch", "catchAll", "catchIf"]);

const isStringLiteral = (node: ESTree.Node): node is ESTree.StringLiteral =>
  node.type === "Literal" && isString(node.value);

export const isTagMember = (
  node: ESTree.Node
): node is ESTree.MemberExpression =>
  node.type === "MemberExpression" &&
  ((!node.computed &&
    node.property.type === "Identifier" &&
    node.property.name === "_tag") ||
    (node.computed &&
      isStringLiteral(node.property) &&
      node.property.value === "_tag"));

export const tagMemberFromComparison = (node: ESTree.BinaryExpression) => {
  if (!equalityOperators.has(node.operator)) {
    return undefined;
  }
  if (isTagMember(node.left) && isStringLiteral(node.right)) {
    return node.left;
  }
  if (isTagMember(node.right) && isStringLiteral(node.left)) {
    return node.right;
  }
  return undefined;
};

const isBroadEffectCatchCall = (
  node: ESTree.Node | null
): node is ESTree.CallExpression =>
  node?.type === "CallExpression" &&
  node.callee.type === "MemberExpression" &&
  node.callee.object.type === "Identifier" &&
  node.callee.object.name === "Effect" &&
  !node.callee.computed &&
  node.callee.property.type === "Identifier" &&
  broadCatchMethods.has(node.callee.property.name);

export const isInsideBroadEffectHandler = (node: ESTree.Node): boolean => {
  for (let current = node.parent; current !== null; current = current.parent) {
    if (
      current.type === "ArrowFunctionExpression" ||
      current.type === "FunctionExpression"
    ) {
      return (
        isBroadEffectCatchCall(current.parent) &&
        current.parent.arguments.includes(current)
      );
    }
  }
  return false;
};

export const isReasonTagMember = (node: ESTree.MemberExpression): boolean =>
  node.object.type === "MemberExpression" &&
  ((!node.object.computed &&
    node.object.property.type === "Identifier" &&
    node.object.property.name === "reason") ||
    (node.object.computed &&
      isStringLiteral(node.object.property) &&
      node.object.property.value === "reason"));
