import { definePlugin, defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const UUID_BUILDER = "uuid";
const TEXT_BUILDER = "text";
const ID_COLUMN_BUILDERS = new Set([UUID_BUILDER, TEXT_BUILDER]);
const KEY_METHODS = new Set(["primaryKey", "references"]);

const isDrizzleModule = (source: string) => source.startsWith("drizzle-orm");

/** The drizzle builder this callee names (`uuid`, `text`), or undefined for any other call. */
const builderOf = (
  callee: ESTree.CallExpression["callee"],
  builders: ReadonlyMap<string, string>,
  namespaces: ReadonlySet<string>,
) => {
  if (callee.type === "Identifier") {
    return builders.get(callee.name);
  }

  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    namespaces.has(callee.object.name) &&
    callee.property.type === "Identifier" &&
    ID_COLUMN_BUILDERS.has(callee.property.name)
  ) {
    return callee.property.name;
  }

  return undefined;
};

/** The method names the builder chain that starts at this call applies, in order. */
const chainMethods = (node: ESTree.CallExpression) => {
  const methods: string[] = [];
  let current: ESTree.Node = node;
  let parent: ESTree.Node | null = node.parent;

  while (parent !== null) {
    if (parent.type === "MemberExpression" && parent.object === current) {
      if (!parent.computed && parent.property.type === "Identifier") {
        methods.push(parent.property.name);
      }
    } else if (parent.type !== "CallExpression" || parent.callee !== current) {
      break;
    }

    current = parent;
    ({ parent } = parent);
  }

  return methods;
};

const requireIdColumnType = defineRule({
  create: (context) => {
    const builders = new Map<string, string>();
    const namespaces = new Set<string>();

    return {
      CallExpression: (node: ESTree.CallExpression) => {
        const builder = builderOf(node.callee, builders, namespaces);
        if (builder === undefined) {
          return;
        }

        const methods = chainMethods(node);
        if (methods.includes("$type")) {
          return;
        }

        const isKey = methods.some((method) => KEY_METHODS.has(method));
        if (builder === UUID_BUILDER || isKey) {
          context.report({ messageId: "requireType", node });
        }
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
            ID_COLUMN_BUILDERS.has(specifier.imported.name)
          ) {
            builders.set(specifier.local.name, specifier.imported.name);
          }
        }
      },
    };
  },
  meta: {
    docs: {
      description:
        "Require Drizzle uuid columns, and text primary or foreign keys, to declare their branded id with $type<...>().",
    },
    messages: {
      requireType:
        "Add $type<...Id>() to this id column with the brand from @computis/shared/ids. Without it the id reads back as a plain string and any other id fits where this one is expected.",
    },
    schema: [],
    type: "problem",
  },
});

export default definePlugin({
  meta: { name: "drizzle-id-policy" },
  rules: { "require-id-column-type": requireIdColumnType },
});
