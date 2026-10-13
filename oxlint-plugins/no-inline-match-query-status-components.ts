import { definePlugin, defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";
import { isString } from "./predicates.ts";

const QUERY_STATUS_MODULE = "@/lib/match-query-status";
const STATUS_NAMES = new Set(["Empty", "Loading", "renderErrored", "renderSuccess"]);
const STATE_FILE_NAMES = new Set(["empty", "errored", "loading", "success"]);

const propertyName = (property: ESTree.ObjectProperty): string | null => {
  if (property.computed) {
    return null;
  }

  if (property.key.type === "Identifier") {
    return property.key.name;
  }

  if (property.key.type === "Literal" && isString(property.key.value)) {
    return property.key.value;
  }

  return null;
};

const unwrapExpression = (expression: ESTree.Expression): ESTree.Expression => {
  if (
    expression.type === "ParenthesizedExpression" ||
    expression.type === "TSAsExpression" ||
    expression.type === "TSSatisfiesExpression" ||
    expression.type === "TSTypeAssertion" ||
    expression.type === "TSNonNullExpression"
  ) {
    return unwrapExpression(expression.expression);
  }

  return expression;
};

const jsxRootName = (name: ESTree.JSXElementName): string | null => {
  if (name.type === "JSXIdentifier") {
    return name.name;
  }

  if (name.type !== "JSXMemberExpression") {
    return null;
  }

  return jsxRootName(name.object);
};

const isComponentName = (name: string) => /^[A-Z]/u.test(name);

const isImportedComponent = (
  expression: ESTree.Expression,
  importedValues: ReadonlySet<string>,
) => {
  const unwrapped = unwrapExpression(expression);

  if (unwrapped.type === "Identifier") {
    return isComponentName(unwrapped.name) && importedValues.has(unwrapped.name);
  }

  if (unwrapped.type !== "JSXElement" || !unwrapped.openingElement.selfClosing) {
    return false;
  }

  const name = jsxRootName(unwrapped.openingElement.name);
  return name !== null && isComponentName(name) && importedValues.has(name);
};

const isMatchQueryStatusCall = (
  expression: ESTree.Expression,
  matchQueryStatusLocals: ReadonlySet<string>,
) => {
  const unwrapped = unwrapExpression(expression);
  return (
    unwrapped.type === "CallExpression" &&
    unwrapped.callee.type === "Identifier" &&
    matchQueryStatusLocals.has(unwrapped.callee.name)
  );
};

const usesExtractedStatus = (
  expression: ESTree.Expression,
  importedValues: ReadonlySet<string>,
  matchQueryStatusLocals: ReadonlySet<string>,
) => {
  const unwrapped = unwrapExpression(expression);

  if (unwrapped.type === "ArrowFunctionExpression") {
    return (
      unwrapped.body.type !== "BlockStatement" &&
      (isImportedComponent(unwrapped.body, importedValues) ||
        isMatchQueryStatusCall(unwrapped.body, matchQueryStatusLocals))
    );
  }

  return isImportedComponent(unwrapped, importedValues);
};

const noInlineMatchQueryStatusComponents = defineRule({
  create: (context) => {
    const importedValues = new Set<string>();
    const matchQueryStatusLocals = new Set<string>();

    return {
      CallExpression: (node: ESTree.CallExpression) => {
        if (node.callee.type !== "Identifier" || !matchQueryStatusLocals.has(node.callee.name)) {
          return;
        }

        const [, options] = node.arguments;
        if (options?.type !== "ObjectExpression") {
          return;
        }

        for (const property of options.properties) {
          if (property.type !== "Property" || property.kind !== "init") {
            continue;
          }

          const status = propertyName(property);
          if (
            status === null ||
            !STATUS_NAMES.has(status) ||
            usesExtractedStatus(property.value, importedValues, matchQueryStatusLocals)
          ) {
            continue;
          }

          context.report({
            data: { status },
            messageId: "noInlineComponent",
            node: property.value,
          });
        }
      },
      ImportDeclaration: (node: ESTree.ImportDeclaration) => {
        if (node.importKind === "type") {
          return;
        }

        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportSpecifier" && specifier.importKind === "type") {
            continue;
          }

          if (
            node.source.value === QUERY_STATUS_MODULE &&
            specifier.type === "ImportSpecifier" &&
            specifier.imported.type === "Identifier" &&
            specifier.imported.name === "matchQueryStatus"
          ) {
            matchQueryStatusLocals.add(specifier.local.name);
            continue;
          }

          importedValues.add(specifier.local.name);
        }
      },
    };
  },
  meta: {
    docs: {
      description:
        "Require every matchQueryStatus branch to render a component imported from a separate file or delegate directly to another matchQueryStatus call.",
    },
    messages: {
      noInlineComponent:
        "Do not define the {{status}} state inline. Extract it to its own component file, import it, and render that component directly.",
    },
    schema: [],
    type: "problem",
  },
});

const renderedComponentName = (
  expression: ESTree.Expression,
  matchQueryStatusLocals: ReadonlySet<string>,
): string | null => {
  const unwrapped = unwrapExpression(expression);

  if (unwrapped.type === "ArrowFunctionExpression") {
    if (
      unwrapped.body.type === "BlockStatement" ||
      isMatchQueryStatusCall(unwrapped.body, matchQueryStatusLocals)
    ) {
      return null;
    }
    return renderedComponentName(unwrapped.body, matchQueryStatusLocals);
  }

  if (unwrapped.type === "Identifier") {
    return unwrapped.name;
  }

  if (unwrapped.type === "JSXElement") {
    return jsxRootName(unwrapped.openingElement.name);
  }

  return null;
};

const splitModulePath = (source: string) => {
  const withoutExtension = source.replace(/\.[jt]sx?$/u, "");
  const separator = withoutExtension.lastIndexOf("/");

  if (separator === -1) {
    return { directory: "", fileName: withoutExtension };
  }

  return {
    directory: withoutExtension.slice(0, separator),
    fileName: withoutExtension.slice(separator + 1),
  };
};

const matchQueryStatusFolderStructure = defineRule({
  create: (context) => {
    const importSources = new Map<string, string>();
    const matchQueryStatusLocals = new Set<string>();

    return {
      CallExpression: (node: ESTree.CallExpression) => {
        if (node.callee.type !== "Identifier" || !matchQueryStatusLocals.has(node.callee.name)) {
          return;
        }

        const [, options] = node.arguments;
        if (options?.type !== "ObjectExpression") {
          return;
        }

        const directories = new Map<string, { node: ESTree.Node; status: string }>();

        for (const property of options.properties) {
          if (property.type !== "Property" || property.kind !== "init") {
            continue;
          }

          const status = propertyName(property);
          if (status === null || !STATUS_NAMES.has(status)) {
            continue;
          }

          const componentName = renderedComponentName(property.value, matchQueryStatusLocals);
          const source = componentName === null ? undefined : importSources.get(componentName);
          if (componentName === null || source === undefined) {
            continue;
          }

          const { directory, fileName } = splitModulePath(source);

          if (!STATE_FILE_NAMES.has(fileName)) {
            context.report({
              data: { component: componentName, fileName, status },
              messageId: "wrongFileName",
              node: property.value,
            });
          }

          if (!directories.has(directory)) {
            directories.set(directory, { node: property.value, status });
          }
        }

        if (directories.size <= 1) {
          return;
        }

        const [first, ...others] = [...directories.entries()];
        if (first === undefined) {
          return;
        }

        const [firstDirectory, firstEntry] = first;
        for (const [directory, entry] of others) {
          context.report({
            data: {
              directory,
              otherDirectory: firstDirectory,
              otherStatus: firstEntry.status,
              status: entry.status,
            },
            messageId: "mixedFolders",
            node: entry.node,
          });
        }
      },
      ImportDeclaration: (node: ESTree.ImportDeclaration) => {
        if (node.importKind === "type" || !isString(node.source.value)) {
          return;
        }

        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportSpecifier" && specifier.importKind === "type") {
            continue;
          }

          if (
            node.source.value === QUERY_STATUS_MODULE &&
            specifier.type === "ImportSpecifier" &&
            specifier.imported.type === "Identifier" &&
            specifier.imported.name === "matchQueryStatus"
          ) {
            matchQueryStatusLocals.add(specifier.local.name);
            continue;
          }

          importSources.set(specifier.local.name, node.source.value);
        }
      },
    };
  },
  meta: {
    docs: {
      description:
        "Require matchQueryStatus state components to live together in one folder as success.tsx, empty.tsx, loading.tsx, and errored.tsx.",
    },
    messages: {
      mixedFolders:
        'The {{status}} state is imported from "{{directory}}" but the {{otherStatus}} state is imported from "{{otherDirectory}}". Keep every state of one matchQueryStatus call in the same folder.',
      wrongFileName:
        'The {{status}} state renders {{component}} from "{{fileName}}". Move it into the state folder as success.tsx, empty.tsx, loading.tsx, or errored.tsx.',
    },
    schema: [],
    type: "problem",
  },
});

export default definePlugin({
  meta: { name: "query-status-policy" },
  rules: {
    "folder-structure": matchQueryStatusFolderStructure,
    "no-inline-components": noInlineMatchQueryStatusComponents,
  },
});
