import { definePlugin, defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const isPgEnumCallee = (node: ESTree.Expression) => {
  if (node.type === "Identifier") {
    return node.name === "pgEnum";
  }

  return (
    node.type === "MemberExpression" &&
    node.property.type === "Identifier" &&
    node.property.name === "pgEnum"
  );
};

const isEnumObjectMember = (node: ESTree.Expression | ESTree.SpreadElement | null) => {
  if (node === null || node.type === "SpreadElement") {
    return false;
  }

  if (node.type !== "MemberExpression" || node.computed) {
    return false;
  }

  return node.object.type === "Identifier" && node.property.type === "Identifier";
};

const noRawPgEnumValues = defineRule({
  create: (context) => ({
    CallExpression: (node: ESTree.CallExpression) => {
      if (!isPgEnumCallee(node.callee)) {
        return;
      }

      const [, values] = node.arguments;
      if (values === undefined) {
        return;
      }

      if (values.type !== "ArrayExpression") {
        context.report({ messageId: "mustUseObjectMembers", node: values });
        return;
      }

      for (const element of values.elements) {
        if (!isEnumObjectMember(element)) {
          context.report({ messageId: "mustUseObjectMembers", node: element ?? values });
        }
      }
    },
  }),
  meta: {
    docs: {
      description:
        "Require Drizzle pgEnum values to come from exported enum-like objects, not raw string arrays.",
    },
    messages: {
      mustUseObjectMembers:
        "Define pgEnum values from a named object (for example [statuses.pending, statuses.failed]) instead of raw strings or standalone arrays.",
    },
    schema: [],
    type: "problem",
  },
});

export default definePlugin({
  meta: { name: "drizzle-policy" },
  rules: { "no-raw-pg-enum-values": noRawPgEnumValues },
});
