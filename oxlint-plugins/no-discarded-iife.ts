import { definePlugin, defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const unwrapParenthesizedExpression = (expression: ESTree.Expression): ESTree.Expression => {
  let current = expression;

  while (current.type === "ParenthesizedExpression") {
    current = current.expression;
  }

  return current;
};

const isFunctionExpression = (node: ESTree.Node) =>
  node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression";

/**
 * True when nothing reads the call's result. Parentheses, `await` and `void` all forward the
 * discard upwards, so `void (async () => {})()` counts exactly like a bare statement, while
 * `const x = (() => 1)()` and `promise ??= (async () => {})()` keep their value and pass.
 */
const isDiscarded = (node: ESTree.Node) => {
  let { parent } = node;

  while (
    parent !== null &&
    (parent.type === "ParenthesizedExpression" || parent.type === "AwaitExpression")
  ) {
    ({ parent } = parent);
  }

  if (parent === null) {
    return false;
  }

  return (
    parent.type === "ExpressionStatement" ||
    (parent.type === "UnaryExpression" && parent.operator === "void")
  );
};

const noDiscardedIife = defineRule({
  create: (context) => ({
    CallExpression: (node: ESTree.CallExpression) => {
      const callee = unwrapParenthesizedExpression(node.callee);

      if (!isFunctionExpression(callee) || !isDiscarded(node)) {
        return;
      }

      context.report({ messageId: "discardedIife", node: callee });
    },
  }),
  meta: {
    docs: {
      description:
        "Disallow creating a function only to call it immediately and throw the result away.",
    },
    messages: {
      discardedIife:
        "Do not build a function only to call it here. Inline its body at this position, or hand the function itself to the caller.",
    },
    schema: [],
    type: "suggestion",
  },
});

export default definePlugin({
  meta: { name: "function-policy" },
  rules: { "no-discarded-iife": noDiscardedIife },
});
