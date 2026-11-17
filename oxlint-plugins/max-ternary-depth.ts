import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import { isNumber, isRecord } from "./predicates.ts";

const unwrapExpression = (node: ESTree.Expression): ESTree.Expression => {
  let current = node;
  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSSatisfiesExpression" ||
    current.type === "TSTypeAssertion" ||
    current.type === "TSNonNullExpression"
  ) {
    current = current.expression;
  }
  return current;
};

const ternaryDepth = (node: ESTree.Expression): number => {
  const expression = unwrapExpression(node);
  if (expression.type !== "ConditionalExpression") {
    return 0;
  }
  return (
    1 +
    Math.max(
      ternaryDepth(expression.test),
      ternaryDepth(expression.consequent),
      ternaryDepth(expression.alternate)
    )
  );
};

const isNestedTernary = (node: ESTree.ConditionalExpression): boolean => {
  let parent = node.parent;
  while (
    parent?.type === "ParenthesizedExpression" ||
    parent?.type === "TSAsExpression" ||
    parent?.type === "TSSatisfiesExpression" ||
    parent?.type === "TSTypeAssertion" ||
    parent?.type === "TSNonNullExpression"
  ) {
    parent = parent.parent;
  }
  return parent?.type === "ConditionalExpression";
};

export const maxTernaryDepthRule = defineRule({
  create: (context) => {
    const [option] = context.options;
    const maxDepth =
      isRecord(option) && isNumber(option.maxDepth) ? option.maxDepth : 2;

    return {
      ConditionalExpression: (node: ESTree.ConditionalExpression) => {
        if (isNestedTernary(node)) {
          return;
        }
        const depth = ternaryDepth(node);
        if (depth > maxDepth) {
          context.report({
            data: { depth, maxDepth },
            messageId: "exceeded",
            node,
          });
        }
      },
    };
  },
  meta: {
    defaultOptions: [{ maxDepth: 2 }],
    docs: {
      description: "Limit ternary expression chains to a configurable depth.",
    },
    messages: {
      exceeded:
        "This ternary has a depth of {{depth}}; the configured maximum is {{maxDepth}}. Use a lookup table, switch, or named decision function.",
    },
    schema: [
      {
        additionalProperties: false,
        properties: { maxDepth: { minimum: 1, type: "integer" } },
        type: "object",
      },
    ],
    type: "problem",
  },
});
