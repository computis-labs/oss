import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const isTagKey = (key: ESTree.Node): boolean =>
  (key.type === "Identifier" && key.name === "_tag") ||
  (key.type === "Literal" && key.value === "_tag");

export const noManualTaggedConstructionRule = defineRule({
  create: (context) => ({
    ObjectExpression: (node: ESTree.ObjectExpression) => {
      const tag = node.properties.find(
        (property) =>
          property.type === "Property" &&
          (!property.computed || property.key.type === "Literal") &&
          isTagKey(property.key)
      );
      if (tag !== undefined) {
        context.report({ messageId: "manualConstruction", node: tag });
      }
    },
    PropertyDefinition: (node: ESTree.PropertyDefinition) => {
      if (isTagKey(node.key)) {
        context.report({ messageId: "manualDeclaration", node });
      }
    },
  }),
  meta: {
    docs: {
      description:
        "Construct tagged values with their existing Effect constructor instead of writing _tag manually.",
    },
    messages: {
      manualConstruction:
        "Use the existing Schema tagged `.make` or tagged class/error constructor instead of writing a literal `_tag` object.",
      manualDeclaration:
        "Declare tagged classes with Schema.TaggedClass, Schema.TaggedError, Data.TaggedClass, or Data.TaggedError instead of writing a literal `_tag` property.",
    },
    schema: [],
    type: "problem",
  },
});
