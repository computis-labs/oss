import { defineRule } from "@oxlint/plugins";
import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

const resolveVariable = (
  sourceCode: SourceCode,
  identifier: ESTree.IdentifierReference
): Variable | null => {
  let scope: Scope | null = sourceCode.getScope(identifier);

  while (scope !== null) {
    const variable = scope.set.get(identifier.name);

    if (variable !== undefined) {
      return variable;
    }
    scope = scope.upper;
  }
  return null;
};

const variableDeclarator = (
  variable: Variable
): ESTree.VariableDeclarator | null => {
  if (variable.defs.length !== 1) {
    return null;
  }

  const [definition] = variable.defs;

  return definition?.type === "Variable" &&
    definition.node.type === "VariableDeclarator"
    ? definition.node
    : null;
};

const unwrapExpression = (expression: ESTree.Expression): ESTree.Expression => {
  let current = expression;

  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSSatisfiesExpression" ||
    current.type === "TSTypeAssertion" ||
    current.type === "TSNonNullExpression"
  ) {
    current = current.expression;
  }
  return current;
};

const importedName = (specifier: ESTree.ImportSpecifier): string =>
  specifier.imported.type === "Identifier"
    ? specifier.imported.name
    : specifier.imported.value;

const isEffectProvideServiceCall = (
  node: ESTree.CallExpression,
  effectNamespaces: ReadonlySet<string>
): boolean => {
  const callee = unwrapExpression(node.callee);

  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    effectNamespaces.has(callee.object.name) &&
    callee.property.type === "Identifier" &&
    callee.property.name === "provideService"
  );
};

const directlyYieldedService = (
  sourceCode: SourceCode,
  expression: ESTree.Expression
): ESTree.Expression | null => {
  const value = unwrapExpression(expression);

  if (value.type !== "Identifier") {
    return null;
  }

  const variable = resolveVariable(sourceCode, value);

  if (variable === null) {
    return null;
  }

  const declarator = variableDeclarator(variable);

  if (declarator?.init === null || declarator?.init === undefined) {
    return null;
  }

  const initializer = unwrapExpression(declarator.init);

  return initializer.type === "YieldExpression" &&
    initializer.delegate &&
    initializer.argument !== null
    ? unwrapExpression(initializer.argument)
    : null;
};

export const noReprovideAmbientServiceRule = defineRule({
  create: (context) => {
    const effectNamespaces = new Set<string>();

    return {
      ImportDeclaration(node) {
        if (node.source.value === "effect") {
          for (const specifier of node.specifiers) {
            if (
              specifier.type === "ImportSpecifier" &&
              importedName(specifier) === "Effect"
            ) {
              effectNamespaces.add(specifier.local.name);
            }
          }
          return;
        }
        if (node.source.value !== "effect/Effect") {
          return;
        }
        for (const specifier of node.specifiers) {
          if (
            specifier.type === "ImportNamespaceSpecifier" ||
            specifier.type === "ImportDefaultSpecifier"
          ) {
            effectNamespaces.add(specifier.local.name);
          }
        }
      },
      CallExpression(node) {
        if (
          !isEffectProvideServiceCall(node, effectNamespaces) ||
          node.arguments.length < 2
        ) {
          return;
        }

        const serviceArgument = node.arguments.at(-2);
        const implementationArgument = node.arguments.at(-1);

        if (
          serviceArgument === undefined ||
          implementationArgument === undefined ||
          serviceArgument.type === "SpreadElement" ||
          implementationArgument.type === "SpreadElement"
        ) {
          return;
        }

        const yieldedService = directlyYieldedService(
          context.sourceCode,
          implementationArgument
        );

        if (yieldedService === null) {
          return;
        }

        const requestedService = unwrapExpression(serviceArgument);

        if (
          context.sourceCode.getText(yieldedService) !==
          context.sourceCode.getText(requestedService)
        ) {
          return;
        }
        context.report({
          data: { service: context.sourceCode.getText(requestedService) },
          messageId: "reprovideAmbientService",
          node,
        });
      },
    };
  },
  meta: {
    docs: {
      description:
        "Disallow re-providing an Effect service yielded directly from the surrounding environment.",
    },
    messages: {
      reprovideAmbientService:
        'Do not capture "{{service}}" from the Effect environment and re-provide it with Effect.provideService. Leave "{{service}}" in the operation\'s R channel and provide its implementing Layer once at the application runtime composition root. If the runtime has an explicit service union, include "{{service}}" there; use Layer.provideMerge when the service must remain available after layer construction. A local provide is only appropriate for a genuinely dynamic implementation, such as a client configured from per-tenant credentials.',
    },
    schema: [],
    type: "problem",
  },
});
