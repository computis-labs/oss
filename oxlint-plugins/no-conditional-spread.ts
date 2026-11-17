import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const isConditionalSpread = (node: ESTree.Expression): boolean => {
  let expression = node;
  while (expression.type === "ParenthesizedExpression") {
    expression = expression.expression;
  }
  return (
    expression.type === "ConditionalExpression" ||
    expression.type === "LogicalExpression"
  );
};

export const noConditionalSpreadRule = defineRule({
  create: (context) => ({
    SpreadElement: (node: ESTree.SpreadElement) => {
      if (isConditionalSpread(node.argument)) {
        context.report({ messageId: "avoid", node });
      }
    },
    JSXSpreadAttribute: (node: ESTree.JSXSpreadAttribute) => {
      if (isConditionalSpread(node.argument)) {
        context.report({ messageId: "avoid", node });
      }
    },
  }),
  meta: {
    docs: {
      description:
        "Disallow spreading ternary and logical expressions. Build the value explicitly instead.",
    },
    messages: {
      avoid:
        "Conditional spreads obscure which values or properties are present. Build the value in separate statements instead.",
    },
    schema: [],
    type: "problem",
  },
});
