import { definePlugin, defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";
import { isObject, isString } from "./predicates.ts";

const isRelative = (source: string) => source.startsWith("./") || source.startsWith("../");

const useRootAlias = defineRule({
  create: (context) => {
    const [option] = context.options;
    const alias =
      isObject(option) && "alias" in option && isString(option.alias) ? option.alias : "@/";

    return {
      ImportDeclaration: (node: ESTree.ImportDeclaration) => {
        if (!isRelative(node.source.value)) {
          return;
        }

        context.report({ data: { alias }, messageId: "useAlias", node: node.source });
      },
    };
  },
  meta: {
    docs: {
      description:
        "Require app-local imports to go through the app's root alias instead of a relative path.",
    },
    messages: {
      useAlias:
        "Import this through the `{{alias}}` alias. A relative path describes where the file sits today, which stops being true once either file moves.",
    },
    schema: [
      {
        additionalProperties: false,
        properties: {
          alias: { type: "string" },
        },
        type: "object",
      },
    ],
    type: "suggestion",
  },
});

const RESTRICTED_SOURCES: readonly (readonly [RegExp, string])[] = [
  [/^@computis\/design-system\/components\/ui\//u, "primitive"],
  [/^@tanstack\/react-table$/u, "tableLibrary"],
];

const noDesignSystemInternals = defineRule({
  create: (context) => ({
    ImportDeclaration: (node: ESTree.ImportDeclaration) => {
      const messageId = RESTRICTED_SOURCES.find(([pattern]) =>
        pattern.test(node.source.value),
      )?.[1];

      if (messageId === undefined) {
        return;
      }

      context.report({ messageId, node: node.source });
    },
  }),
  meta: {
    docs: {
      description:
        "Disallow importing design-system primitives or the table library outside the design system.",
    },
    messages: {
      primitive:
        "Import the public component instead, for example @computis/design-system/components/button. The ui/ modules are the pieces it is built from.",
      tableLibrary:
        "Use the design-system data table. Building a table pipeline here puts column and sorting behaviour outside the component that is meant to own it.",
    },
    schema: [],
    type: "suggestion",
  },
});

export default definePlugin({
  meta: { name: "import-policy" },
  rules: {
    "no-design-system-internals": noDesignSystemInternals,
    "use-root-alias": useRootAlias,
  },
});
