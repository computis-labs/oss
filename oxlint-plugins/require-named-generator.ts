import { definePlugin, defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";
import { isObject } from "./predicates.ts";

const requireNamedGenerator = defineRule({
  create: (context) => {
    const [option] = context.options;
    const allowUnnamedGenerators =
      isObject(option) &&
      "allowUnnamedGenerators" in option &&
      option.allowUnnamedGenerators === true;

    return {
      FunctionExpression: (node: ESTree.Function) => {
        // A method takes its name from the key it is declared under, so there is nothing to
        // ask for: `class A { b() {} }` and `{ b() {} }` both label their own frame.
        const parentType = node.parent?.type;
        if (parentType === "MethodDefinition" || parentType === "Property") {
          return;
        }

        if (node.id !== null || (node.generator && allowUnnamedGenerators)) {
          return;
        }

        context.report({
          messageId: node.generator ? "unnamedGenerator" : "unnamedFunction",
          node,
        });
      },
    };
  },
  meta: {
    docs: {
      description:
        "Require generator function expressions outside tests to be named, so they are identifiable in a stack trace.",
    },
    messages: {
      unnamedFunction:
        "Name this function expression, or write it as an arrow so it takes a name from what it is assigned to.",
      unnamedGenerator:
        "Name this generator. It cannot take a name from its surroundings, so without one the stack frame reads as anonymous.",
    },
    schema: [
      {
        additionalProperties: false,
        properties: {
          allowUnnamedGenerators: { type: "boolean" },
        },
        type: "object",
      },
    ],
    type: "suggestion",
  },
});

export default definePlugin({
  meta: { name: "generator-policy" },
  rules: { "require-named-generator": requireNamedGenerator },
});
