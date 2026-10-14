import { definePlugin, defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";
import { isObject, isString } from "./predicates.ts";

/**
 * Design-system components outside components/ui must not accept class names.
 * A className prop is a styling escape hatch: it lets call sites restyle a
 * component ad hoc, so the design decision leaks out of the design system.
 * Only the ui primitives (packages/ds/src/components/ui) may take className.
 *
 * Four shapes leak class names and are reported:
 * 1. A declared `className` / `classNames` / `*ClassName(s)` property signature.
 * 2. The same names destructured from a function parameter (catches props
 *    inherited from ComponentProps and friends).
 * 3. A ComponentProps / HTMLAttributes-style type reference that is not
 *    narrowed with `Omit<..., "className">`, a `Pick` without className, or
 *    an indexed access (catches `{...props}` pass-through components).
 * 4. Outside packages/ds, class names passed through an object option such as
 *    `toast(message, { classNames })`, or through a `classNames` /
 *    `*ClassName(s)` JSX attribute. `className` on an element stays allowed.
 */

type NodeLike = { type: string } & Record<string, unknown> & ESTree.Node;

interface Span {
  end?: number;
  range?: readonly [number, number];
  start?: number;
}

interface Finding {
  name: string;
  node: NodeLike;
}

const isNode = (value: unknown): value is NodeLike =>
  isObject(value) && "type" in value && isString(value.type);

const spanStart = (span: Span) => span.start ?? span.range?.[0] ?? -1;

const spanEnd = (span: Span) => span.end ?? span.range?.[1] ?? -1;

const walk = (node: NodeLike, visit: (node: NodeLike) => void) => {
  visit(node);

  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) {
          walk(item, visit);
        }
      }
    } else if (isNode(value)) {
      walk(value, visit);
    }
  }
};

const isClassNameProp = (name: string) =>
  name === "className" ||
  name === "classNames" ||
  name.endsWith("ClassName") ||
  name.endsWith("ClassNames");

const isDesignSystemFile = (filename: string) =>
  filename.replaceAll("\\", "/").includes("/packages/ds/");

const jsxAttributeName = (name: unknown): string | undefined =>
  isNode(name) && name.type === "JSXIdentifier" && isString(name.name) ? name.name : undefined;

const keyName = (key: unknown): string | undefined => {
  if (!isNode(key)) {
    return undefined;
  }
  if (key.type === "Identifier" && isString(key.name)) {
    return key.name;
  }
  if (key.type === "Literal" && isString(key.value)) {
    return key.value;
  }

  return undefined;
};

const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

const COMPONENT_PROPS_TYPES = new Set([
  "ComponentProps",
  "ComponentPropsWithRef",
  "ComponentPropsWithoutRef",
  "SVGAttributes",
  "SVGProps",
]);

const isHtmlPropsTypeName = (name: string) =>
  COMPONENT_PROPS_TYPES.has(name) || name.endsWith("HTMLAttributes");

const typeReferenceName = (typeName: unknown): string | undefined => {
  if (!isNode(typeName)) {
    return undefined;
  }
  if (typeName.type === "Identifier" && isString(typeName.name)) {
    return typeName.name;
  }
  // React.ComponentProps<"div">
  if (typeName.type === "TSQualifiedName") {
    return typeReferenceName(typeName.right);
  }
  if (typeName.type === "MemberExpression") {
    return typeReferenceName(typeName.property);
  }

  return undefined;
};

// `Omit<...>` in `interface X extends Omit<...>` is a heritage clause, not a
// TSTypeReference; both shapes carry a name and type arguments.
const namedTypeUsage = (node: NodeLike): string | undefined => {
  if (node.type === "TSTypeReference") {
    return typeReferenceName(node.typeName);
  }
  if (node.type === "TSInterfaceHeritage") {
    return typeReferenceName(node.expression);
  }

  return undefined;
};

const typeArgumentsOf = (node: NodeLike) => {
  const args = node.typeArguments ?? node.typeParameters;
  if (!isNode(args) || !Array.isArray(args.params)) {
    return [];
  }

  return args.params.filter(isNode);
};

const literalKeysInclude = (node: NodeLike, predicate: (name: string) => boolean): boolean => {
  if (node.type === "TSUnionType" && Array.isArray(node.types)) {
    return node.types.some((member) => isNode(member) && literalKeysInclude(member, predicate));
  }
  if (node.type === "TSLiteralType" && isNode(node.literal)) {
    const { literal } = node;

    return literal.type === "Literal" && isString(literal.value) && predicate(literal.value);
  }

  return false;
};

const collectPatternClassNames = (pattern: NodeLike, findings: Finding[]) => {
  const target =
    pattern.type === "AssignmentPattern" && isNode(pattern.left) ? pattern.left : pattern;
  if (target.type !== "ObjectPattern" || !Array.isArray(target.properties)) {
    return;
  }
  for (const property of target.properties) {
    if (!isNode(property) || property.type !== "Property") {
      continue;
    }
    const name = keyName(property.key);
    if (name !== undefined && isClassNameProp(name)) {
      findings.push({ name, node: property });
    }
    if (isNode(property.value)) {
      collectPatternClassNames(property.value, findings);
    }
  }
};

const noClassNameProps = defineRule({
  create: (context) => ({
    Program: (program: ESTree.Program) => {
      if (!isNode(program)) {
        return;
      }

      const declared: Finding[] = [];
      const destructured: Finding[] = [];
      const htmlPropsReferences: Finding[] = [];
      const passed: Finding[] = [];
      const allowedRanges: (readonly [number, number])[] = [];
      const checksPassedClassNames = !isDesignSystemFile(context.filename);

      walk(program, (node) => {
        if (checksPassedClassNames && node.type === "ObjectExpression") {
          for (const property of Array.isArray(node.properties) ? node.properties : []) {
            if (!isNode(property) || property.type !== "Property" || property.computed === true) {
              continue;
            }
            const name = keyName(property.key);
            if (name !== undefined && isClassNameProp(name)) {
              passed.push({ name, node: property });
            }
          }
          return;
        }
        if (checksPassedClassNames && node.type === "JSXAttribute") {
          const name = jsxAttributeName(node.name);
          if (name !== undefined && name !== "className" && isClassNameProp(name)) {
            passed.push({ name, node });
          }
          return;
        }
        if (node.type === "TSPropertySignature") {
          const name = keyName(node.key);
          if (name !== undefined && isClassNameProp(name)) {
            declared.push({ name, node });
          }
          return;
        }
        if (FUNCTION_TYPES.has(node.type) && Array.isArray(node.params)) {
          for (const param of node.params) {
            if (isNode(param)) {
              collectPatternClassNames(param, destructured);
            }
          }
          return;
        }
        // ComponentProps<"th">["aria-sort"] extracts one member, not a props surface.
        if (node.type === "TSIndexedAccessType" && isNode(node.objectType)) {
          allowedRanges.push([spanStart(node.objectType), spanEnd(node.objectType)]);
          return;
        }
        const name = namedTypeUsage(node);
        if (name === undefined) {
          return;
        }
        if (name === "Omit" || name === "Pick") {
          const [target, keys] = typeArgumentsOf(node);
          if (target === undefined || keys === undefined) {
            return;
          }
          const mentionsClassName = literalKeysInclude(keys, (key) => key === "className");
          const isSafe = name === "Omit" ? mentionsClassName : !mentionsClassName;
          if (isSafe) {
            allowedRanges.push([spanStart(target), spanEnd(target)]);
          }
          return;
        }
        if (isHtmlPropsTypeName(name)) {
          htmlPropsReferences.push({ name, node });
        }
      });

      const declaredNames = new Set(declared.map((finding) => finding.name));
      const isAllowed = (node: NodeLike) => {
        const position = spanStart(node);

        return allowedRanges.some(([start, end]) => position >= start && position < end);
      };

      for (const { name, node } of declared) {
        context.report({ data: { name }, messageId: "declared", node });
      }
      for (const { name, node } of destructured) {
        if (!declaredNames.has(name)) {
          context.report({ data: { name }, messageId: "destructured", node });
        }
      }
      for (const { name, node } of htmlPropsReferences) {
        if (!isAllowed(node)) {
          context.report({ data: { name }, messageId: "inherited", node });
        }
      }
      for (const { name, node } of passed) {
        context.report({ data: { name }, messageId: "passed", node });
      }
    },
  }),
  meta: {
    docs: {
      description:
        "Disallow class-name props on design-system components outside components/ui. Only the ui primitives may accept className.",
    },
    messages: {
      declared:
        "Do not declare the '{{name}}' prop here. Only components in ds/components/ui can accept class names; expose a semantic prop or move the style into the ui primitive.",
      destructured:
        "Do not accept the '{{name}}' prop here. Only components in ds/components/ui can accept class names; expose a semantic prop or move the style into the ui primitive.",
      inherited:
        "'{{name}}' includes the 'className' prop, so callers can restyle this component. Exclude it with Omit<..., \"className\">.",
      passed:
        "Do not pass class names through '{{name}}'. Only ds/components/ui may restyle a component; add a variant or a semantic prop to the ui primitive.",
    },
    schema: [],
    type: "suggestion",
  },
});

export default definePlugin({
  meta: { name: "ds-policy" },
  rules: { "no-class-name-props": noClassNameProps },
});
