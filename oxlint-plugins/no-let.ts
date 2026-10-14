import { definePlugin, defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const isLoopCounter = (node: ESTree.VariableDeclaration) =>
  node.parent?.type === "ForStatement" && node.parent.init === node;

const noLet = defineRule({
  create: (context) => ({
    VariableDeclaration: (node: ESTree.VariableDeclaration) => {
      if (node.kind !== "let" || isLoopCounter(node)) {
        return;
      }

      context.report({ messageId: "noLet", node });
    },
  }),
  meta: {
    docs: {
      description:
        "Disallow `let` outside a classic `for` loop counter. Bind every value once with `const`.",
    },
    messages: {
      noLet:
        "Use `const` instead of `let`. Derive the value in one expression (a ternary, `reduce`, `Array.from`, an Effect combinator) instead of reassigning it.",
    },
    schema: [],
    type: "suggestion",
  },
});

export default definePlugin({
  meta: { name: "variable-policy" },
  rules: { "no-let": noLet },
});
