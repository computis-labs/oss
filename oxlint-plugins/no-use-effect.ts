import { definePlugin, defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";
import { isObject, isString } from "./predicates.ts";

interface NamedNode {
  name: string;
  type: "Identifier";
}

interface NodeLike {
  [key: string]: unknown;
  type?: unknown;
}

// NodeLike only claims an index signature and an optional `type`, which any object satisfies,
// so an object check is the whole proof. Every read below is guarded again.
const isNodeLike = (value: unknown): value is NodeLike => isObject(value);

const asNode = (value: unknown) => (isNodeLike(value) ? value : null);

const isIdentifier = (node: unknown, name?: string): node is NamedNode => {
  const candidate = asNode(node);
  return (
    candidate?.type === "Identifier" &&
    isString(candidate.name) &&
    (name === undefined || candidate.name === name)
  );
};

const literalStringValue = (node: unknown): string | null => {
  const candidate = asNode(node);
  return candidate?.type === "Literal" && isString(candidate.value) ? candidate.value : null;
};

const memberPropertyName = (node: unknown): string | null => {
  const candidate = asNode(node);
  if (candidate?.type !== "MemberExpression") {
    return null;
  }

  if (candidate.computed === true) {
    return literalStringValue(candidate.property);
  }

  if (isIdentifier(candidate.property)) {
    return candidate.property.name;
  }

  return null;
};

// The helper the rule points callers to. It is where a single useEffect is meant to live, so a
// call whose nearest enclosing function is the helper is the sanctioned use, not a violation.
const SANCTIONED_HELPERS = new Set(["useMountEffect"]);

const functionName = (node: ESTree.Node): string | null => {
  if (node.type === "FunctionDeclaration") {
    return node.id?.name ?? null;
  }
  const { parent } = node;
  return parent?.type === "VariableDeclarator" && parent.id.type === "Identifier"
    ? parent.id.name
    : null;
};

const isInsideSanctionedHelper = (node: ESTree.Node) => {
  let current: ESTree.Node | null = node.parent;
  while (current !== null) {
    if (
      current.type === "ArrowFunctionExpression" ||
      current.type === "FunctionExpression" ||
      current.type === "FunctionDeclaration"
    ) {
      const name = functionName(current);
      return name !== null && SANCTIONED_HELPERS.has(name);
    }
    current = current.parent;
  }
  return false;
};

const noDirectUseEffect = defineRule({
  create: (context) => {
    const reactUseEffectLocals = new Set<string>(["useEffect"]);
    const reactNamespaceLocals = new Set<string>();

    return {
      CallExpression: (node: ESTree.CallExpression) => {
        const { callee } = node;
        const memberCallee = asNode(callee);
        const memberObject = asNode(memberCallee?.object);
        const isUseEffectCall =
          (isIdentifier(callee) && reactUseEffectLocals.has(callee.name)) ||
          (memberCallee?.type === "MemberExpression" &&
            memberPropertyName(callee) === "useEffect" &&
            isIdentifier(memberObject) &&
            reactNamespaceLocals.has(memberObject.name));

        if (!isUseEffectCall || isInsideSanctionedHelper(node)) {
          return;
        }

        context.report({ messageId: "noDirectUseEffect", node: callee });
      },
      ImportDeclaration: (node: ESTree.ImportDeclaration) => {
        if (node.source.value !== "react") {
          return;
        }

        for (const specifier of node.specifiers) {
          if (
            specifier.type === "ImportNamespaceSpecifier" ||
            specifier.type === "ImportDefaultSpecifier"
          ) {
            reactNamespaceLocals.add(specifier.local.name);
            continue;
          }

          if (
            specifier.type === "ImportSpecifier" &&
            isIdentifier(specifier.imported, "useEffect")
          ) {
            reactUseEffectLocals.add(specifier.local.name);
          }
        }
      },
    };
  },
  meta: {
    docs: {
      description:
        "Disallow useEffect calls. Prefer derived state, event handlers, useMemo, useSyncExternalStore, data-fetching libraries, key-based resets, or the shared helper useMountEffect.",
    },
    messages: {
      noDirectUseEffect:
        "Do not call useEffect. Derive state, use an event handler/useMemo/useSyncExternalStore/data-fetching library/key reset, or use the shared helper useMountEffect().",
    },
    schema: [],
    type: "problem",
  },
});

export default definePlugin({
  meta: { name: "react-hooks-policy" },
  rules: { "no-direct-use-effect": noDirectUseEffect },
});
