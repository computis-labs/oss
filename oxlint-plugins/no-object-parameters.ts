import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import {
  functionParameterBindingName,
  functionParameterTypeAnnotation,
} from "./anti-slop/function-parameters.ts";
import {
  createTypeAliasEnvironment,
  resolvedTypeMatches,
} from "./anti-slop/type-alias-resolution.ts";
import type { TypeAliasEnvironment } from "./anti-slop/type-alias-resolution.ts";

type ParameterOwner =
  | ESTree.ArrowFunctionExpression
  | ESTree.Function
  | ESTree.TSCallSignatureDeclaration
  | ESTree.TSConstructSignatureDeclaration
  | ESTree.TSConstructorType
  | ESTree.TSFunctionType
  | ESTree.TSMethodSignature;

export const noObjectParametersRule = defineRule({
  create: (context) => {
    let environment: TypeAliasEnvironment | null = null;

    const resolvesToObject = (type: ESTree.TSType): boolean =>
      environment !== null &&
      resolvedTypeMatches(type, environment, (resolved, matches) => {
        if (resolved.type === "TSObjectKeyword") {
          return true;
        }
        if (resolved.type === "TSParenthesizedType") {
          return matches(resolved.typeAnnotation);
        }
        return resolved.type === "TSUnionType" && resolved.types.some(matches);
      });

    const checkParameters = (node: ParameterOwner) => {
      for (const parameter of node.params) {
        const annotation = functionParameterTypeAnnotation(parameter);

        if (annotation === null || annotation === undefined) {
          continue;
        }
        if (!resolvesToObject(annotation.typeAnnotation)) {
          continue;
        }
        context.report({
          data: {
            parameter: functionParameterBindingName(
              parameter,
              context.sourceCode
            ),
          },
          messageId: "objectParameter",
          node: annotation.typeAnnotation,
        });
      }
    };

    return {
      Program(node) {
        environment = createTypeAliasEnvironment(
          node,
          context.sourceCode.visitorKeys
        );
      },
      ArrowFunctionExpression: checkParameters,
      FunctionDeclaration: checkParameters,
      FunctionExpression: checkParameters,
      TSCallSignatureDeclaration: checkParameters,
      TSConstructSignatureDeclaration: checkParameters,
      TSConstructorType: checkParameters,
      TSDeclareFunction: checkParameters,
      TSEmptyBodyFunctionExpression: checkParameters,
      TSFunctionType: checkParameters,
      TSMethodSignature: checkParameters,
    };
  },
  meta: {
    docs: {
      description:
        "Disallow broad object function parameters, including local aliases.",
    },
    messages: {
      objectParameter:
        "Parameter `{{parameter}}` uses the broad `object` type. Accept a named owner type; parse external input at its boundary before calling this function.",
    },
    schema: [],
    type: "problem",
  },
});
