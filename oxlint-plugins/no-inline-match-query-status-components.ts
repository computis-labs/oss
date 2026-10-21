import { definePlugin, defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";
import { isInterfaceDeclaration } from "typescript/unstable/ast/is";
import type { NodeHandle } from "typescript/unstable/sync";
import { isString } from "./predicates.ts";
import { projectFor } from "./type-information.ts";

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

const STATUS_FLAGS = ["isError", "isLoading", "isPending", "isSuccess"];

const isQueryResultDeclaration = (declaration: NodeHandle) => {
  if (!declaration.path.includes("/@tanstack/query-core/")) {
    return false;
  }
  const owner = declaration.resolve()?.parent;
  return (
    owner !== undefined &&
    isInterfaceDeclaration(owner) &&
    /^(?:Infinite)?QueryObserver\w*Result$/u.test(owner.name.getText())
  );
};

const yieldsJsx = (expression: ESTree.Expression): boolean => {
  const unwrapped = unwrapExpression(expression);
  if (unwrapped.type === "JSXElement" || unwrapped.type === "JSXFragment") {
    return true;
  }
  if (unwrapped.type === "ConditionalExpression") {
    return yieldsJsx(unwrapped.consequent) || yieldsJsx(unwrapped.alternate);
  }
  if (unwrapped.type === "LogicalExpression") {
    return yieldsJsx(unwrapped.right);
  }
  return false;
};

type FunctionNode = ESTree.ArrowFunctionExpression | ESTree.Function;

const isFunctionNode = (node: ESTree.Node): node is FunctionNode =>
  node.type === "ArrowFunctionExpression" ||
  node.type === "FunctionDeclaration" ||
  node.type === "FunctionExpression";

const enclosingFunction = (node: ESTree.Node): FunctionNode | null => {
  const parent = node.parent;
  if (parent === undefined || parent === null) {
    return null;
  }
  return isFunctionNode(parent) ? parent : enclosingFunction(parent);
};

const functionName = (fn: FunctionNode) => {
  if (fn.type !== "ArrowFunctionExpression" && fn.id !== null && fn.id !== undefined) {
    return fn.id.name;
  }
  if (fn.parent?.type === "VariableDeclarator" && fn.parent.id.type === "Identifier") {
    return fn.parent.id.name;
  }
  return null;
};

const isComponent = (fn: FunctionNode | null) => {
  const name = fn === null ? null : functionName(fn);
  return name !== null && isComponentName(name);
};

const isReturned = (expression: ESTree.Node): boolean => {
  const parent = expression.parent;
  if (parent?.type === "ParenthesizedExpression") {
    return isReturned(parent);
  }
  return (
    parent?.type === "ReturnStatement" ||
    (parent?.type === "ArrowFunctionExpression" && parent.body === expression)
  );
};

const returnsIn = (statement: ESTree.Node): ESTree.ReturnStatement[] => {
  if (statement.type === "ReturnStatement") {
    return [statement];
  }
  if (statement.type === "BlockStatement") {
    return statement.body.flatMap(returnsIn);
  }
  if (statement.type === "IfStatement") {
    return [
      ...returnsIn(statement.consequent),
      ...(statement.alternate === null ? [] : returnsIn(statement.alternate)),
    ];
  }
  return [];
};

const returnsFromComponent = (statement: ESTree.IfStatement) => {
  const returns = returnsIn(statement.consequent);
  return (
    returns.length > 0 &&
    (isComponent(enclosingFunction(statement)) ||
      returns.some((node) => node.argument !== null && yieldsJsx(node.argument)))
  );
};

const preferMatchQueryStatus = defineRule({
  create: (context) => {
    const branchesOnStatus = (node: ESTree.Node, depth: number): boolean => {
      const parent = node.parent;
      if (parent === undefined || parent === null) {
        return false;
      }
      switch (parent.type) {
        case "ParenthesizedExpression":
        case "TSNonNullExpression":
        case "TSAsExpression":
        case "TSSatisfiesExpression":
          return branchesOnStatus(parent, depth);
        case "UnaryExpression":
          return parent.operator === "!" && branchesOnStatus(parent, depth);
        case "BinaryExpression":
          return (
            (parent.operator === "===" || parent.operator === "!==") &&
            branchesOnStatus(parent, depth)
          );
        case "LogicalExpression":
          return (
            (parent.operator !== "??" && parent.left === node && yieldsJsx(parent.right)) ||
            branchesOnStatus(parent, depth)
          );
        case "ConditionalExpression":
          return (
            parent.test === node &&
            (yieldsJsx(parent.consequent) ||
              yieldsJsx(parent.alternate) ||
              (isReturned(parent) && isComponent(enclosingFunction(parent))))
          );
        case "IfStatement":
          return parent.test === node && returnsFromComponent(parent);
        case "VariableDeclarator":
          return (
            depth === 0 &&
            parent.init === node &&
            parent.parent?.type === "VariableDeclaration" &&
            parent.parent.kind === "const" &&
            context.sourceCode
              .getDeclaredVariables(parent)
              .flatMap((variable) => variable.references)
              .some(
                (reference) => !reference.init && branchesOnStatus(reference.identifier, depth + 1),
              )
          );
        default:
          return false;
      }
    };

    const readsQueryResult = (node: ESTree.MemberExpression) => {
      const project = projectFor(context.physicalFilename);
      const symbol = project.checker.getSymbolAtPosition(
        context.physicalFilename,
        node.property.end - 1,
      );
      return symbol?.declarations.some(isQueryResultDeclaration) === true;
    };

    return {
      MemberExpression: (node: ESTree.MemberExpression) => {
        if (
          node.computed ||
          node.property.type !== "Identifier" ||
          !STATUS_FLAGS.includes(node.property.name) ||
          !branchesOnStatus(node, 0) ||
          !readsQueryResult(node)
        ) {
          return;
        }
        context.report({
          data: { flag: node.property.name },
          messageId: "preferMatchQueryStatus",
          node,
        });
      },
    };
  },
  meta: {
    docs: {
      description:
        "Render the states of a query with matchQueryStatus instead of branching on its status flags.",
    },
    messages: {
      preferMatchQueryStatus:
        "Do not branch on `{{flag}}` to pick what the component renders. Render the query with matchQueryStatus from @/lib/match-query-status and its loading, errored and success state components.",
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
    "prefer-match-query-status": preferMatchQueryStatus,
  },
});
