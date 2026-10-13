import { definePlugin, defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const isDateIdentifier = (node: ESTree.Expression | ESTree.TSTypeName) =>
  node.type === "Identifier" && node.name === "Date";

const noBackendDate = defineRule({
  create: (context) => {
    let isDrizzleSchemaFile = false;

    const report = (node: ESTree.Node) => {
      if (isDrizzleSchemaFile) {
        return;
      }

      context.report({ messageId: "noBackendDate", node });
    };

    return {
      CallExpression: (node: ESTree.CallExpression) => {
        const { callee } = node;

        if (isDateIdentifier(callee)) {
          report(callee);
          return;
        }

        if (callee.type === "MemberExpression" && isDateIdentifier(callee.object)) {
          report(callee.object);
        }
      },
      ImportDeclaration: (node: ESTree.ImportDeclaration) => {
        if (node.source.value === "drizzle-orm/pg-core") {
          isDrizzleSchemaFile = true;
        }
      },
      NewExpression: (node: ESTree.NewExpression) => {
        if (isDateIdentifier(node.callee)) {
          report(node.callee);
        }
      },
      TSTypeReference: (node: ESTree.TSTypeReference) => {
        if (isDateIdentifier(node.typeName)) {
          report(node.typeName);
        }
      },
    };
  },
  meta: {
    docs: {
      description:
        "Disallow direct JavaScript Date usage in backend code outside Drizzle schema files.",
    },
    messages: {
      noBackendDate:
        "Do not use JavaScript Date directly in backend code outside Drizzle schemas. Use an Effect.DateTime.",
    },
    schema: [],
    type: "problem",
  },
});

export default definePlugin({
  meta: { name: "backend-time" },
  rules: { "no-date-outside-drizzle-schema": noBackendDate },
});
