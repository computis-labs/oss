import { definePlugin, defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";
import { isString } from "./predicates.ts";

const TAG_PROPERTY = "_tag";

const staticPropertyName = (node: ESTree.Node): string | null => {
  if (node.type === "Identifier") {
    return node.name;
  }

  if (node.type === "Literal" && isString(node.value)) {
    return node.value;
  }

  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? null;
  }

  return null;
};

const noDirectTagAccess = defineRule({
  create: (context) => ({
    MemberExpression: (node: ESTree.MemberExpression) => {
      if (staticPropertyName(node.property) === TAG_PROPERTY) {
        context.report({ messageId: "directAccess", node: node.property });
      }
    },
    Property: (node) => {
      if (node.parent.type === "ObjectPattern" && staticPropertyName(node.key) === TAG_PROPERTY) {
        context.report({ messageId: "directAccess", node: node.key });
      }
    },
    TSInterfaceDeclaration: (node: ESTree.TSInterfaceDeclaration) => {
      for (const member of node.body.body) {
        if (
          (member.type === "TSPropertySignature" || member.type === "TSMethodSignature") &&
          staticPropertyName(member.key) === TAG_PROPERTY
        ) {
          context.report({ messageId: "interfaceTag", node: member.key });
        }
      }
    },
  }),
  meta: {
    docs: {
      description:
        "Disallow direct _tag access and _tag members in interfaces. Use Effect tag utilities instead.",
    },
    messages: {
      directAccess:
        "Do not access `_tag` directly. Use an Effect utility such as Match.tag, Predicate.isTagged, Result.isFailure, or Result.isSuccess.",
      interfaceTag:
        "Do not define `_tag` in an interface. Use an Effect tagged type or a discriminated union type alias.",
    },
    schema: [],
    type: "problem",
  },
});

export default definePlugin({
  meta: { name: "effect-tag-policy" },
  rules: { "no-direct-tag-access": noDirectTagAccess },
});
