import { definePlugin, defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const unaliasedModules = new Set(["Array", "Record", "String"]);

const importedName = (specifier: ESTree.ImportSpecifier) =>
  specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value;

const noEffectModuleAlias = defineRule({
  create: (context) => ({
    ImportDeclaration: (node: ESTree.ImportDeclaration) => {
      if (node.source.value !== "effect") {
        return;
      }

      for (const specifier of node.specifiers) {
        if (specifier.type !== "ImportSpecifier") {
          continue;
        }

        const name = importedName(specifier);

        if (unaliasedModules.has(name) && specifier.local.name !== name) {
          context.report({
            data: { alias: specifier.local.name, name },
            messageId: "noAlias",
            node: specifier,
          });
        }
      }
    },
  }),
  meta: {
    docs: {
      description:
        "Import the effect Array, Record and String modules under their own names, not an alias.",
    },
    messages: {
      noAlias:
        "Import `{{name}}` from effect as `{{name}}`, not `{{alias}}`: the effect module stands in for the native one, so it keeps the native name.",
    },
    schema: [],
    type: "suggestion",
  },
});

export default definePlugin({
  meta: { name: "effect-import-policy" },
  rules: { "no-effect-module-alias": noEffectModuleAlias },
});
