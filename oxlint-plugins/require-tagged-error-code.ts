import { definePlugin, defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";
import { isString } from "./predicates.ts";

const taggedErrorTag = (superClass: ESTree.Expression | null) => {
  if (superClass === null || superClass.type !== "CallExpression") {
    return null;
  }

  const { callee } = superClass;
  const isDataFactory =
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    callee.object.name === "Data" &&
    callee.property.type === "Identifier" &&
    callee.property.name === "TaggedError";

  if (!isDataFactory) {
    return null;
  }

  const [tag] = superClass.arguments;
  if (tag === undefined || tag.type !== "Literal" || !isString(tag.value)) {
    return null;
  }

  return tag.value;
};

const expectedCode = (tag: string) => {
  const withoutSuffix =
    tag.length > "Error".length && tag.endsWith("Error") ? tag.slice(0, -"Error".length) : tag;

  return withoutSuffix
    .replaceAll(/(?<tail>[a-z0-9])(?<head>[A-Z])/gu, "$<tail>_$<head>")
    .replaceAll(/(?<acronym>[A-Z]+)(?<word>[A-Z][a-z])/gu, "$<acronym>_$<word>")
    .replaceAll(/[^A-Za-z0-9]+/gu, "_")
    .toUpperCase();
};

const isCodeKey = (key: ESTree.PropertyKey) => {
  if (key.type === "Identifier") {
    return key.name === "code";
  }

  return key.type === "Literal" && key.value === "code";
};

const codeMember = (body: ESTree.ClassBody) =>
  body.body.find(
    (member) =>
      (member.type === "PropertyDefinition" || member.type === "AccessorProperty") &&
      !member.computed &&
      isCodeKey(member.key),
  );

const requireTaggedErrorCode = defineRule({
  create: (context) => {
    const checkClass = (node: ESTree.Class) => {
      const tag = taggedErrorTag(node.superClass);
      if (tag === null) {
        return;
      }

      const code = expectedCode(tag);
      const member = codeMember(node.body);

      if (member === undefined) {
        context.report({
          data: { code, tag },
          fix: (fixer) =>
            fixer.insertTextAfterRange(
              [node.body.start, node.body.start + 1],
              `\n  readonly code = ${JSON.stringify(code)};\n`,
            ),
          messageId: "missingCode",
          node: node.id ?? node,
        });
        return;
      }

      if (member.type !== "PropertyDefinition" || member.static) {
        context.report({ data: { code }, messageId: "instanceFieldRequired", node: member });
        return;
      }

      const { value } = member;
      if (value === null || value.type !== "Literal" || !isString(value.value)) {
        context.report({ data: { code }, messageId: "literalCodeRequired", node: member });
        return;
      }

      if (value.value !== code) {
        context.report({
          data: { actual: value.value, code, tag },
          fix: (fixer) => fixer.replaceText(value, JSON.stringify(code)),
          messageId: "codeMismatch",
          node: value,
        });
      }
    };

    return { ClassDeclaration: checkClass, ClassExpression: checkClass };
  },
  meta: {
    docs: {
      description:
        "Require every Data.TaggedError class to carry a fixed SCREAMING_SNAKE_CASE code field derived from its tag.",
    },
    fixable: "code",
    messages: {
      codeMismatch:
        "Error '{{tag}}' declares code '{{actual}}'. Use the code derived from the tag: readonly code = \"{{code}}\".",
      instanceFieldRequired:
        'Declare the error code as a readonly instance field: readonly code = "{{code}}". A static or accessor member does not travel with the error value.',
      literalCodeRequired:
        'The error code must be a fixed string literal: readonly code = "{{code}}".',
      missingCode:
        "Error '{{tag}}' has no fixed code. Add readonly code = \"{{code}}\" to the class body, because a message or a cause alone does not identify the error.",
    },
    schema: [],
    type: "problem",
  },
});

export default definePlugin({
  meta: { name: "error-code-policy" },
  rules: { "require-tagged-error-code": requireTaggedErrorCode },
});
