import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

export const noInOperatorRule = defineRule({
  create: (context) => ({
    BinaryExpression: (node: ESTree.BinaryExpression) => {
      if (node.operator !== "in") {
        return;
      }

      context.report({ messageId: "noInOperator", node });
    },
  }),
  meta: {
    docs: {
      description:
        "Disallow the JavaScript `in` operator for object key presence checks and union narrowing.",
    },
    messages: {
      noInOperator:
        "Do not use the `in` operator to check object keys or narrow unions. Use a tagged union with Match, Schema.is, or an explicit property check.",
    },
    schema: [],
    type: "suggestion",
  },
});
