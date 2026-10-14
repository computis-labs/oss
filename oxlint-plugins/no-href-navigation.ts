import { definePlugin, defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";
import { isObject, isString } from "./predicates.ts";

/**
 * Internal navigation must go through the TanStack Router `Link`. A raw `href`
 * renders a native anchor, which triggers a full document load and tears down
 * the router, query cache and every piece of client state.
 */

const attributeName = (name: ESTree.JSXAttributeName) =>
  name.type === "JSXNamespacedName" ? `${name.namespace.name}:${name.name.name}` : name.name;

const elementName = (name: ESTree.JSXElementName): string => {
  if (name.type === "JSXMemberExpression") {
    return `${elementName(name.object)}.${name.property.name}`;
  }
  if (name.type === "JSXNamespacedName") {
    return `${name.namespace.name}:${name.name.name}`;
  }

  return name.name;
};

/**
 * Only app-internal paths are router destinations. Absolute URLs, protocol
 * relative URLs, fragments and non-http schemes (mailto:, tel:) legitimately
 * belong on a native anchor.
 */
const isInternalPath = (value: string) => value.startsWith("/") && !value.startsWith("//");

const literalPath = (node: ESTree.JSXExpression | ESTree.JSXAttributeValue): string | undefined => {
  if (node.type === "Literal") {
    return isString(node.value) ? node.value : undefined;
  }
  // Template literals: href={`/pmi/impostazioni/integrazioni/${id}`}
  if (node.type === "TemplateLiteral") {
    return node.quasis[0]?.value.raw;
  }

  return undefined;
};

const noHrefNavigation = defineRule({
  create(context) {
    const [option] = context.options;
    const ignored =
      option !== null &&
      isObject(option) &&
      !Array.isArray(option) &&
      Array.isArray(option.ignoreComponents)
        ? new Set(option.ignoreComponents.filter((value): value is string => isString(value)))
        : new Set<string>();

    return {
      JSXOpeningElement(node: ESTree.JSXOpeningElement) {
        const element = elementName(node.name);
        if (ignored.has(element)) {
          return;
        }

        for (const attribute of node.attributes) {
          if (attribute.type !== "JSXAttribute" || attributeName(attribute.name) !== "href") {
            continue;
          }

          const { value } = attribute;
          if (value === null) {
            continue;
          }

          const path = literalPath(
            value.type === "JSXExpressionContainer" ? value.expression : value,
          );
          if (path === undefined || !isInternalPath(path)) {
            continue;
          }

          context.report({
            data: { element },
            messageId: element === "a" ? "anchor" : "component",
            node: attribute,
          });
        }
      },
    };
  },
  meta: {
    docs: {
      description:
        "Disallow internal navigation via href. Use the TanStack Router Link so navigation stays client side.",
    },
    messages: {
      anchor:
        'Internal navigation through a native <a href> triggers a full page reload. Use <Link to="..." /> from @tanstack/react-router instead.',
      component:
        '`href` on <{{element}}> renders a native anchor and reloads the whole app. Pass a router link instead, e.g. render={<Link to="..." />}.',
    },
    schema: [
      {
        additionalProperties: false,
        properties: {
          ignoreComponents: { items: { type: "string" }, type: "array" },
        },
        type: "object",
      },
    ],
    type: "problem",
  },
});

export default definePlugin({
  meta: { name: "router-policy" },
  rules: { "no-href-navigation": noHrefNavigation },
});
