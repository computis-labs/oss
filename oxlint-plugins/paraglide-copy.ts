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

/**
 * Copy that changes with a value belongs in the Paraglide message, as a variant: plurals, exact
 * numbers, enum values and `variant(flag)` all select inside one message. Two messages behind a
 * ternary or an if/return split one sentence across keys and keep the rule in code, out of the
 * translator's sight.
 */
const withoutParentheses = (node: ESTree.Node): ESTree.Node =>
  node.type === "ParenthesizedExpression" ? withoutParentheses(node.expression) : node;

const noBranchingCopy = defineRule({
  create(context) {
    const messageNamespaces = new Set<string>();

    const isMessageCall = (node: ESTree.Node | null | undefined): boolean => {
      if (node === null || node === undefined) {
        return false;
      }
      const expression = withoutParentheses(node);
      if (expression.type !== "CallExpression") {
        return false;
      }
      const { callee } = expression;
      return (
        callee.type === "MemberExpression" &&
        !callee.computed &&
        callee.object.type === "Identifier" &&
        messageNamespaces.has(callee.object.name)
      );
    };

    const isCopyChoice = (node: ESTree.Node): boolean => {
      const expression = withoutParentheses(node);
      if (expression.type !== "ConditionalExpression") {
        return isMessageCall(expression);
      }
      return isCopyChoice(expression.consequent) && isCopyChoice(expression.alternate);
    };

    const returnedMessage = (statement: ESTree.Statement | null | undefined): boolean => {
      if (statement === null || statement === undefined) {
        return false;
      }
      if (statement.type === "BlockStatement") {
        return statement.body.length === 1 && returnedMessage(statement.body[0]);
      }
      return statement.type === "ReturnStatement" && isMessageCall(statement.argument);
    };

    const nextStatement = (node: ESTree.IfStatement): ESTree.Statement | undefined => {
      const { parent } = node;
      if (parent?.type !== "BlockStatement" && parent?.type !== "Program") {
        return undefined;
      }
      const body: readonly ESTree.Node[] = parent.body;
      const next = body[body.indexOf(node) + 1];
      return next?.type === "ReturnStatement" ? next : undefined;
    };

    const enclosing = (node: ESTree.Node): ESTree.Node | null =>
      node.parent?.type === "ParenthesizedExpression"
        ? enclosing(node.parent)
        : (node.parent ?? null);

    return {
      ConditionalExpression(node: ESTree.ConditionalExpression) {
        const parent = enclosing(node);
        if (parent?.type === "ConditionalExpression" && isCopyChoice(parent)) {
          return;
        }
        if (isCopyChoice(node)) {
          context.report({ messageId: "conditional", node });
        }
      },
      IfStatement(node: ESTree.IfStatement) {
        if (!returnedMessage(node.consequent)) {
          return;
        }
        if (returnedMessage(node.alternate ?? nextStatement(node))) {
          context.report({ messageId: "ifReturn", node });
        }
      },
      ImportDeclaration(node: ESTree.ImportDeclaration) {
        if (!/\/paraglide\/messages(?:\.js)?$/u.test(node.source.value)) {
          return;
        }
        for (const specifier of node.specifiers) {
          messageNamespaces.add(specifier.local.name);
        }
      },
    };
  },
  meta: {
    docs: {
      description:
        "Disallow choosing between Paraglide messages in code. Pass the value to one message and select the variant there.",
    },
    messages: {
      conditional:
        "Do not pick a Paraglide message with a ternary. Pass the value to one message and select the variant inside it: a count with `plural`, an enum value, or a flag with variant(flag).",
      ifReturn:
        "Do not pick a Paraglide message with if/return. Pass the value to one message and select the variant inside it: a count with `plural`, an enum value, or a flag with variant(flag).",
    },
    schema: [],
    type: "suggestion",
  },
});

export default definePlugin({
  meta: { name: "paraglide-copy" },
  rules: { "no-branching-copy": noBranchingCopy, "no-raw-copy": noRawCopy },
});
