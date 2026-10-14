import { definePlugin, defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const JSON_COLUMN_BUILDERS = new Set(["json", "jsonb"]);

const isDrizzleModule = (source: string) => source.startsWith("drizzle-orm");

const isJsonColumnCallee = (
  callee: ESTree.CallExpression["callee"],
  builders: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
) => {
  if (callee.type === "Identifier") {
    return builders.has(callee.name);
  }

  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    namespaces.has(callee.object.name) &&
    callee.property.type === "Identifier" &&
    JSON_COLUMN_BUILDERS.has(callee.property.name)
  );
};

/** True when the builder chain that starts at this call applies `.$type<...>()`. */
const hasTypeInChain = (node: ESTree.CallExpression) => {
  let current: ESTree.Node = node;
  let parent: ESTree.Node | null = node.parent;

  while (parent !== null) {
    if (parent.type === "MemberExpression" && parent.object === current) {
      if (
        !parent.computed &&
        parent.property.type === "Identifier" &&
        parent.property.name === "$type"
      ) {
        return true;
      }
    } else if (parent.type !== "CallExpression" || parent.callee !== current) {
      return false;
    }

    current = parent;
    ({ parent } = parent);
  }

  return false;
};

const requireJsonbColumnType = defineRule({
  create: (context) => {
    const builders = new Set<string>();
    const namespaces = new Set<string>();

    return {
      CallExpression: (node: ESTree.CallExpression) => {
        if (!isJsonColumnCallee(node.callee, builders, namespaces)) {
          return;
        }

        if (hasTypeInChain(node)) {
          return;
        }

        context.report({ messageId: "requireType", node });
      },
      ImportDeclaration: (node: ESTree.ImportDeclaration) => {
        if (!isDrizzleModule(node.source.value)) {
          return;
        }

        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportNamespaceSpecifier") {
            namespaces.add(specifier.local.name);
            continue;
          }

          if (
            specifier.type === "ImportSpecifier" &&
            specifier.imported.type === "Identifier" &&
            JSON_COLUMN_BUILDERS.has(specifier.imported.name)
          ) {
            builders.add(specifier.local.name);
          }
        }
      },
    };
  },
  meta: {
    docs: {
      description:
        "Require Drizzle json and jsonb columns to declare their payload shape with $type<...>().",
    },
    messages: {
      requireType:
        "Add $type<...>() to this Drizzle json column. Without it the column reads back as unknown and every consumer has to assert its shape.",
    },
    schema: [],
    type: "problem",
  },
});

export default definePlugin({
  meta: { name: "drizzle-column-policy" },
  rules: { "require-jsonb-column-type": requireJsonbColumnType },
});
