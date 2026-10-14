import { definePlugin, defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

/**
 * Class names must be composed with `cn()`. Hand-rolled composition in the JSX
 * attribute (template literals, `+` concatenation, ternaries, `&&`/`||`) drops
 * the tailwind-merge pass, so a later utility no longer wins over an earlier
 * one and conflicting classes ship silently. It also hides the class strings
 * from the tailwindcss lint rules, which only read literal arguments.
 *
 * Allowed values are a plain string literal, a reference (identifier or member
 * access) and any call, so `cn(...)` and cva variant helpers both pass. Move
 * every condition into the `cn()` arguments: cn("base", open && "is-open").
 */

const attributeName = (name: ESTree.JSXAttributeName) =>
  name.type === "JSXNamespacedName" ? `${name.namespace.name}:${name.name.name}` : name.name;

const isClassNameProp = (name: string) => name === "className" || name.endsWith("ClassName");

const messageIdFor = (expression: ESTree.JSXExpression): string | undefined => {
  // Parentheses survive in the oxlint AST: className={(open ? "a" : "b")}.
  if (expression.type === "ParenthesizedExpression") {
    return messageIdFor(expression.expression);
  }
  if (expression.type === "TemplateLiteral" || expression.type === "TaggedTemplateExpression") {
    return "template";
  }
  if (expression.type === "BinaryExpression") {
    return expression.operator === "+" ? "concatenation" : undefined;
  }
  if (expression.type === "ConditionalExpression") {
    return "conditional";
  }
  if (expression.type === "LogicalExpression") {
    return "logical";
  }

  return undefined;
};

const noDynamicClassName = defineRule({
  create: (context) => ({
    JSXOpeningElement(node: ESTree.JSXOpeningElement) {
      for (const attribute of node.attributes) {
        if (attribute.type !== "JSXAttribute") {
          continue;
        }

        const name = attributeName(attribute.name);
        if (!isClassNameProp(name)) {
          continue;
        }

        const { value } = attribute;
        if (value === null || value.type !== "JSXExpressionContainer") {
          continue;
        }

        const messageId = messageIdFor(value.expression);
        if (messageId === undefined) {
          continue;
        }

        context.report({ data: { name }, messageId, node: attribute });
      }
    },
  }),
  meta: {
    docs: {
      description:
        "Disallow composing class names inside the className attribute. Compose them with cn() so tailwind-merge resolves conflicts.",
    },
    messages: {
      concatenation:
        "Do not concatenate class names with '+' in '{{name}}'. Pass the parts to cn(), e.g. className={cn(base, extra)}.",
      conditional:
        'Do not branch on class names in \'{{name}}\'. Move the condition into cn(), e.g. className={cn("base", isActive && "is-active")}.',
      logical:
        "Do not build class names with '&&' or '||' in '{{name}}'. Pass the operands to cn(), e.g. className={cn(\"base\", isActive && \"is-active\")}.",
      template:
        "Do not build class names with a template literal in '{{name}}'. Pass each part to cn(), e.g. className={cn(\"base\", columnsClass[columns])}.",
    },
    schema: [],
    type: "problem",
  },
});

export default definePlugin({
  meta: { name: "class-name-policy" },
  rules: { "no-dynamic-class-name": noDynamicClassName },
});
