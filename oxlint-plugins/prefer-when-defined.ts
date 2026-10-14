import { definePlugin, defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const unwrap = (expression: ESTree.Expression): ESTree.Expression => {
  let current = expression;

  while (current.type === "ParenthesizedExpression") {
    current = current.expression;
  }

  return current;
};

const isNullish = (expression: ESTree.Expression | ESTree.PrivateIdentifier) =>
  (expression.type === "Identifier" && expression.name === "undefined") ||
  (expression.type === "Literal" && expression.value === null);

/**
 * The branches of a conditional that tests one value against `undefined` or `null`: the
 * branch that runs when the value is missing, and the one that runs when it is there.
 */
const nullishBranches = (node: ESTree.ConditionalExpression) => {
  const test = unwrap(node.test);

  if (test.type !== "BinaryExpression" || !(isNullish(test.left) || isNullish(test.right))) {
    return undefined;
  }

  if (test.operator === "===" || test.operator === "==") {
    return { defined: unwrap(node.alternate), missing: unwrap(node.consequent) };
  }

  if (test.operator === "!==" || test.operator === "!=") {
    return { defined: unwrap(node.consequent), missing: unwrap(node.alternate) };
  }

  return undefined;
};

type Argument = ESTree.CallExpression["arguments"][number];

/**
 * True when the call of the defined branch passes the arguments of the other call and only
 * adds keys to its last one: `f()` against `f({ key })`, `f({ a })` against `f({ a, key })`,
 * or `f(query)` against `f({ ...query, key })`.
 */
const addsKeysOnly = (
  text: (node: ESTree.Node) => string,
  missing: readonly Argument[],
  defined: readonly Argument[],
) => {
  const last = defined.at(-1);

  if (
    last?.type !== "ObjectExpression" ||
    (defined.length !== missing.length && defined.length !== missing.length + 1)
  ) {
    return false;
  }

  const shared = defined.slice(0, -1);

  if (
    shared.some(
      (argument, index) => missing[index] === undefined || text(argument) !== text(missing[index]),
    )
  ) {
    return false;
  }

  const base = missing[defined.length - 1];

  if (base === undefined) {
    return true;
  }

  const keys = last.properties.map(text);

  if (base.type === "ObjectExpression") {
    const baseKeys = base.properties.map(text);
    return keys.length > baseKeys.length && baseKeys.every((key) => keys.includes(key));
  }

  return last.properties.some(
    (property) => property.type === "SpreadElement" && text(property.argument) === text(base),
  );
};

const preferWhenDefined = defineRule({
  create: (context) => {
    const text = (node: ESTree.Node) => context.sourceCode.getText(node);

    return {
      ConditionalExpression: (node: ESTree.ConditionalExpression) => {
        const branches = nullishBranches(node);

        if (branches === undefined) {
          return;
        }

        const { defined, missing } = branches;

        if (
          missing.type === "ObjectExpression" &&
          missing.properties.length === 0 &&
          defined.type === "ObjectExpression" &&
          defined.properties.length > 0
        ) {
          context.report({ messageId: "emptyObject", node });
          return;
        }

        if (
          missing.type === "CallExpression" &&
          defined.type === "CallExpression" &&
          text(missing.callee) === text(defined.callee) &&
          addsKeysOnly(text, missing.arguments, defined.arguments)
        ) {
          context.report({ messageId: "duplicatedCall", node });
        }
      },
    };
  },
  meta: {
    docs: {
      description:
        "Build an optional key with whenDefined instead of a conditional that writes the object or the call twice.",
    },
    messages: {
      duplicatedCall:
        "Both branches make the same call and one only adds keys. Make the call once and spread the optional keys with whenDefined from @computis/shared/object.",
      emptyObject:
        "Spread the optional key with whenDefined from @computis/shared/object instead of choosing between {} and an object.",
    },
    schema: [],
    type: "suggestion",
  },
});

export default definePlugin({
  meta: { name: "object-policy" },
  rules: { "prefer-when-defined": preferWhenDefined },
});
