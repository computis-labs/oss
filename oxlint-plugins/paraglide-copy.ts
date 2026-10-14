import { definePlugin, defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";
import { isObject, isString } from "./predicates.ts";

/**
 * Attributes whose string values are user-facing copy and therefore must come
 * from Paraglide messages (`m.*()`), not hardcoded strings.
 */
const DEFAULT_COPY_ATTRIBUTES: readonly string[] = [
  "label",
  "placeholder",
  "title",
  "alt",
  "description",
  "helperText",
  "errorText",
  "emptyText",
  "caption",
  "heading",
  "subheading",
  "tooltip",
  "message",
  "aria-label",
  "aria-description",
  "aria-placeholder",
];

const containsLetters = (value: string) => /\p{L}/u.test(value);

const attributeName = (name: ESTree.JSXAttributeName) =>
  name.type === "JSXNamespacedName" ? `${name.namespace.name}:${name.name.name}` : name.name;

/** A string literal or a template with copy in it, reached through any branching. */
const copyLiteral = (expression: ESTree.JSXExpression): ESTree.Expression | undefined => {
  if (expression.type === "ParenthesizedExpression") {
    return copyLiteral(expression.expression);
  }
  if (expression.type === "Literal") {
    return isString(expression.value) && containsLetters(expression.value) ? expression : undefined;
  }
  if (expression.type === "TemplateLiteral") {
    return expression.quasis.some((quasi) => containsLetters(quasi.value.raw))
      ? expression
      : undefined;
  }
  // `title={saved ? "Salvato" : "Salva"}` and `label={name || "Senza nome"}` hide copy in a
  // branch, so each branch is examined rather than the expression as a whole.
  if (expression.type === "ConditionalExpression") {
    return (
      copyLiteral(expression.consequent) ??
      copyLiteral(expression.alternate) ??
      copyLiteral(expression.test)
    );
  }
  if (expression.type === "LogicalExpression") {
    return copyLiteral(expression.left) ?? copyLiteral(expression.right);
  }

  return undefined;
};

const noRawCopy = defineRule({
  create(context) {
    const [option] = context.options;
    const extra =
      option !== null &&
      isObject(option) &&
      !Array.isArray(option) &&
      Array.isArray(option.copyAttributes)
        ? option.copyAttributes.filter((value): value is string => isString(value))
        : [];
    const copyAttributes = new Set([...DEFAULT_COPY_ATTRIBUTES, ...extra]);

    return {
      JSXAttribute(node: ESTree.JSXAttribute) {
        const name = attributeName(node.name);
        if (!copyAttributes.has(name)) {
          return;
        }
        const { value } = node;
        // String literal: <Foo label="Save" />
        if (value?.type === "Literal" && isString(value.value)) {
          if (!containsLetters(value.value)) {
            return;
          }
          context.report({ data: { attribute: name }, messageId: "attribute", node: value });
          return;
        }
        // Expression container: label={"Save"}, label={`Save`}, label={saved ? "a" : "b"}.
        if (value?.type === "JSXExpressionContainer") {
          const found = copyLiteral(value.expression);
          if (found !== undefined) {
            context.report({ data: { attribute: name }, messageId: "attribute", node: found });
          }
        }
      },
      // A child expression renders exactly like text: <p>{"Salva"}</p> shows the same word as
      // <p>Salva</p>, so it is held to the same rule.
      JSXExpressionContainer(node: ESTree.JSXExpressionContainer) {
        const parentType = node.parent?.type;
        if (parentType !== "JSXElement" && parentType !== "JSXFragment") {
          return;
        }
        const found = copyLiteral(node.expression);
        if (found === undefined) {
          return;
        }
        const text = context.sourceCode.getText(found);
        context.report({
          data: { text: text.length > 32 ? `${text.slice(0, 32)}…` : text },
          messageId: "jsxText",
          node: found,
        });
      },
      JSXText(node: ESTree.JSXText) {
        const text = node.value.trim();
        if (text.length === 0 || !containsLetters(text)) {
          return;
        }
        context.report({
          data: { text: text.length > 32 ? `${text.slice(0, 32)}…` : text },
          messageId: "jsxText",
          node,
        });
      },
    };
  },
  meta: {
    docs: {
      description:
        "Disallow hardcoded user-facing copy in React components. Use Paraglide messages (m.*()) instead.",
    },
    messages: {
      attribute:
        "Hardcoded copy in the `{{attribute}}` prop. Pass a Paraglide message via m.*() instead of a string literal.",
      jsxText:
        'Hardcoded copy "{{text}}" in JSX. Move it to a Paraglide message and render it via m.*().',
    },
    schema: [
      {
        additionalProperties: false,
        properties: {
          copyAttributes: { items: { type: "string" }, type: "array" },
        },
        type: "object",
      },
    ],
    type: "problem",
  },
});

export default definePlugin({
  meta: { name: "paraglide-copy" },
  rules: { "no-raw-copy": noRawCopy },
});
