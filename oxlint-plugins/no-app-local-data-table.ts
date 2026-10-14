import { definePlugin, defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";
import { isObject, isString } from "./predicates.ts";

const dataTableModule = "@computis/design-system/components/data-table";
const localHooks = new Set(["useDataTable", "useLocalDataTable"]);
const rawServerStateHook = "useDataTableState";

const noAppLocalDataTable = defineRule({
  create(context) {
    const [option] = context.options;
    const allowedPaths =
      option !== null &&
      isObject(option) &&
      !Array.isArray(option) &&
      Array.isArray(option.allowedPaths)
        ? option.allowedPaths.filter((value): value is string => isString(value))
        : [];
    const stateOwnerPaths =
      option !== null &&
      isObject(option) &&
      !Array.isArray(option) &&
      Array.isArray(option.stateOwnerPaths)
        ? option.stateOwnerPaths.filter((value): value is string => isString(value))
        : [];

    return {
      ImportDeclaration(node: ESTree.ImportDeclaration) {
        if (
          node.source.value !== dataTableModule ||
          allowedPaths.some((allowedPath) => context.filename.endsWith(allowedPath))
        ) {
          return;
        }

        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier" || specifier.imported.type !== "Identifier") {
            continue;
          }

          if (localHooks.has(specifier.imported.name)) {
            context.report({ messageId: "serverRequired", node: specifier });
          } else if (
            specifier.imported.name === rawServerStateHook &&
            !stateOwnerPaths.some((stateOwnerPath) => context.filename.endsWith(stateOwnerPath))
          ) {
            context.report({ messageId: "standardQueryRequired", node: specifier });
          }
        }
      },
    };
  },
  meta: {
    docs: {
      description:
        "Require server-owned sorting, filtering, and pagination for application data tables.",
    },
    messages: {
      serverRequired:
        "Application tables must use useServerDataTable. Local table processing is only allowed for reviewed finite data.",
      standardQueryRequired:
        "Server-backed application tables must use useServerDataTableQuery instead of wiring useDataTableState directly.",
    },
    schema: [
      {
        additionalProperties: false,
        properties: {
          allowedPaths: { items: { type: "string" }, type: "array" },
          stateOwnerPaths: { items: { type: "string" }, type: "array" },
        },
        type: "object",
      },
    ],
    type: "problem",
  },
});

export default definePlugin({
  meta: { name: "data-table-policy" },
  rules: { "no-app-local-data-table": noAppLocalDataTable },
});
