import { definePlugin, defineRule } from "@oxlint/plugins";

import type { ESTree, Options } from "@oxlint/plugins";
import { isPlainObject, isString } from "./predicates.ts";

type OptionValue = Options[number];

interface RuleOptions {
  readonly allowEmptyString?: boolean | undefined;
  readonly allowNumericLiterals?: boolean | undefined;
  readonly allowPathLiterals?: boolean | undefined;
  readonly allowTypeofChecks?: boolean | undefined;
  readonly allowUppercaseLiterals?: boolean | undefined;
  readonly allowedLiterals?: readonly string[] | undefined;
}

const EQUALITY_OPERATORS = new Set(["==", "===", "!=", "!=="]);

const asRecord = (value: OptionValue | undefined): Readonly<Record<string, OptionValue>> =>
  isPlainObject(value) && !Array.isArray(value) ? value : {};

const readBoolean = (source: Readonly<Record<string, OptionValue>>, key: string) => {
  const value = source[key];

  return value === true || value === false ? value : undefined;
};

// The options arrive as raw config JSON, so every field is read through its own check: a
// mistyped entry falls back to the default instead of reaching the rule as the wrong shape.
const asOptions = (value: OptionValue | undefined): RuleOptions => {
  const source = asRecord(value);
  const { allowedLiterals } = source;

  return {
    allowEmptyString: readBoolean(source, "allowEmptyString"),
    allowNumericLiterals: readBoolean(source, "allowNumericLiterals"),
    allowPathLiterals: readBoolean(source, "allowPathLiterals"),
    allowTypeofChecks: readBoolean(source, "allowTypeofChecks"),
    allowUppercaseLiterals: readBoolean(source, "allowUppercaseLiterals"),
    allowedLiterals: Array.isArray(allowedLiterals)
      ? allowedLiterals.filter((entry) => isString(entry))
      : undefined,
  };
};

const stringValue = (node: ESTree.Expression): string | null => {
  if (node.type === "Literal" && isString(node.value)) {
    return node.value;
  }

  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw ?? null;
  }

  return null;
};

const isTypeofExpression = (node: ESTree.Expression) =>
  node.type === "UnaryExpression" && node.operator === "typeof";

const isUppercaseLiteral = (value: string) => /[A-Z]/u.test(value) && value === value.toUpperCase();

const shouldIgnoreLiteral = (value: string, options: RuleOptions) => {
  const allowed = new Set(options.allowedLiterals);

  return (
    allowed.has(value) ||
    (options.allowEmptyString !== false && value.length === 0) ||
    (options.allowNumericLiterals === true && /^\d+(?:[.-]\d+)*$/u.test(value)) ||
    (options.allowPathLiterals === true && value.startsWith("/")) ||
    (options.allowUppercaseLiterals === true && isUppercaseLiteral(value))
  );
};

const noStringLiteralComparison = defineRule({
  create: (context) => {
    const options = asOptions(context.options[0]);
    const allowTypeofChecks = options.allowTypeofChecks !== false;

    return {
      BinaryExpression: (node: ESTree.BinaryExpression) => {
        if (!EQUALITY_OPERATORS.has(node.operator)) {
          return;
        }

        const leftLiteral = stringValue(node.left);
        const rightLiteral = stringValue(node.right);

        if (leftLiteral === null && rightLiteral === null) {
          return;
        }

        if (leftLiteral !== null && rightLiteral !== null) {
          return;
        }

        const literal = leftLiteral ?? rightLiteral;
        const literalNode = leftLiteral === null ? node.right : node.left;
        const valueNode = leftLiteral === null ? node.left : node.right;

        if (literal === null || shouldIgnoreLiteral(literal, options)) {
          return;
        }

        if (allowTypeofChecks && isTypeofExpression(valueNode)) {
          return;
        }

        context.report({
          data: { literal },
          messageId: "noStringLiteralComparison",
          node: literalNode,
        });
      },
    };
  },
  meta: {
    docs: {
      description:
        "Disallow equality checks against string literals. Compare against named constants instead so domain values remain searchable and refactorable.",
    },
    messages: {
      noStringLiteralComparison:
        'Do not compare against the string literal "{{literal}}". Export/use a named constant (for example OutcomeTypes.running) instead.',
    },
    schema: [
      {
        additionalProperties: false,
        properties: {
          allowEmptyString: { type: "boolean" },
          allowNumericLiterals: { type: "boolean" },
          allowPathLiterals: { type: "boolean" },
          allowTypeofChecks: { type: "boolean" },
          allowUppercaseLiterals: { type: "boolean" },
          allowedLiterals: { items: { type: "string" }, type: "array" },
        },
        type: "object",
      },
    ],
    type: "problem",
  },
});

export default definePlugin({
  meta: { name: "literal-policy" },
  rules: { "no-string-literal-comparison": noStringLiteralComparison },
});
