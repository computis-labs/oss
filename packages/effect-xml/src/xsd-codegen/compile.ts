import { Array as Arr, Result } from "effect";
import type { XsdCodegenError } from "../errors/xsd-codegen-error.ts";
import { IDENTIFIER, makeAllocator, pascal } from "./identifiers.ts";
import { renderModule } from "./render-module.ts";
import type { Built, Declaration, ModuleOptions } from "./render-module.ts";
import { describeDomainKey } from "./domain.ts";
import { fail, XSD_NAMESPACE } from "./schema-document.ts";
import type { XsdNode } from "./schema-document.ts";
import { emitScalar, quote } from "./simple-type/emit.ts";
import { builtinSpec, isBuiltin, restrict } from "./simple-type/restrict.ts";
import type { SimpleSpec } from "./simple-type/restrict.ts";

interface Field {
  readonly code: string;
  readonly name: string;
  readonly optional: boolean;
}

type Alternative = readonly Field[];

type Compiled<A> = Result.Result<A, XsdCodegenError>;

type BuildComplex = (node: XsdNode, owner: string) => Compiled<Built>;

const MAX_ALTERNATIVES = 64;

const indent = (code: string) => code.replaceAll("\n", "\n  ");

const resolveQName = (
  node: XsdNode,
  attribute: string,
): Compiled<{ readonly local: string; readonly namespace: string; readonly raw: string }> => {
  const raw = node.attributes.get(attribute) ?? "";
  const colon = raw.indexOf(":");
  const prefix = colon === -1 ? "" : raw.slice(0, colon);
  const namespace = node.namespaces[prefix];
  if (namespace === undefined && prefix !== "") {
    return fail(node, `The prefix ${prefix} of ${raw} is not bound to a namespace.`);
  }
  return Result.succeed({ local: raw.slice(colon + 1), namespace: namespace ?? "", raw });
};

const parseOccurs = (node: XsdNode) => {
  const minText = node.attributes.get("minOccurs") ?? "1";
  const maxText = node.attributes.get("maxOccurs") ?? "1";
  const min = Number(minText);
  const max = maxText === "unbounded" ? undefined : Number(maxText);
  if (max === 0) {
    return fail(node, 'maxOccurs="0" is not supported.');
  }
  return Result.succeed({ max, min });
};

export const compileSchema = (schema: XsdNode, options: ModuleOptions): Compiled<string> =>
  Result.gen(function* compileXsd() {
    const targetNamespace = schema.attributes.get("targetNamespace") ?? "";
    const qualified = schema.attributes.get("elementFormDefault") === "qualified";
    const attributesQualified = schema.attributes.get("attributeFormDefault") === "qualified";

    const indexSchema = () =>
      Result.gen(function* indexTopLevel() {
        const elements = new Map<string, XsdNode>();
        const types = new Map<string, XsdNode>();
        const substitutionHeads = new Set<string>();
        for (const child of schema.children) {
          const name = child.attributes.get("name") ?? "";
          if (["include", "redefine", "override"].includes(child.local)) {
            return yield* fail(child, `xs:${child.local} is not supported.`);
          }
          if (child.local === "element") {
            elements.set(name, child);
            substitutionHeads.add(child.attributes.get("substitutionGroup") ?? "");
          } else if (child.local === "simpleType" || child.local === "complexType") {
            types.set(name, child);
          }
        }
        substitutionHeads.delete("");
        return { elements, substitutionHeads, types };
      });
    const { elements, substitutionHeads, types } = yield* indexSchema();

    const allocate = makeAllocator();
    const typeIdentifiers = new Map([...types.keys()].map((name) => [name, allocate(name)]));
    const rootIdentifier = allocate(options.root);

    const { domain } = options;
    const domainImport =
      domain === undefined ? undefined : { ...domain, local: allocate(domain.export) };
    const domainKeys = new Set(domain?.keys);
    const unusedKeys = new Set(domainKeys);
    const wrap = (key: string, code: string) => {
      if (domainImport === undefined || !domainKeys.has(key)) {
        return code;
      }
      unusedKeys.delete(key);
      const member = IDENTIFIER.test(key) ? `.${key}` : `[${quote(key)}]`;
      return `${domainImport.local}${member}(${code})`;
    };
    const wrapBuilt = (key: string) => (built: Built) => ({
      ...built,
      code: wrap(key, built.code),
    });

    const declarations = new Map<string, Declaration>();
    const building = new Set<string>();
    const usage = new Map<string, number>();
    const imports = new Set<string>(["root"]);
    const notes: string[] = [];
    const simpleSpecs = new Map<XsdNode, SimpleSpec>();
    const resolvingSpecs = new Set<XsdNode>();

    const declare = (
      key: string,
      identifier: string,
      node: XsdNode,
      build: () => Compiled<Built>,
    ): Compiled<Declaration> =>
      Result.gen(function* declareType() {
        const existing = declarations.get(key);
        if (existing !== undefined) {
          return existing;
        }
        if (building.has(key)) {
          return yield* fail(node, "Recursive types are not supported.");
        }
        building.add(key);
        const built = yield* build();
        building.delete(key);
        const declaration: Declaration = { ...built, identifier };
        declarations.set(key, declaration);
        return declaration;
      });

    const simpleSpec = (node: XsdNode): Compiled<SimpleSpec> =>
      Result.gen(function* resolveSimpleType() {
        const cached = simpleSpecs.get(node);
        if (cached !== undefined) {
          return cached;
        }
        if (resolvingSpecs.has(node)) {
          return yield* fail(node, "The simple type derives from itself.");
        }
        const [restriction] = node.children;
        if (restriction?.local !== "restriction") {
          return yield* fail(
            restriction ?? node,
            `xs:${restriction?.local ?? "simpleType"} simple types are not supported.`,
          );
        }
        resolvingSpecs.add(node);
        const inline = restriction.children.find((child) => child.local === "simpleType");
        const base = yield* inline === undefined
          ? Result.flatMap(resolveQName(restriction, "base"), (name) => {
              const named = name.namespace === targetNamespace ? types.get(name.local) : undefined;
              if (name.namespace === XSD_NAMESPACE && isBuiltin(name.local)) {
                return Result.succeed(builtinSpec(name.local));
              }
              return named?.local === "simpleType"
                ? simpleSpec(named)
                : fail(restriction, `The base type ${name.raw} is not supported.`);
            })
          : simpleSpec(inline);
        const spec = yield* restrict(base, restriction);
        resolvingSpecs.delete(node);
        simpleSpecs.set(node, spec);
        return spec;
      });

    const buildSimple = (node: XsdNode, spec: SimpleSpec): Compiled<Built> =>
      Result.map(emitScalar(spec, node), (scalar) => {
        for (const helper of scalar.helpers) {
          imports.add(helper);
        }
        return { attributes: [], code: scalar.code, complex: false };
      });

    const typeReference = (
      node: XsdNode,
      attribute: string,
      buildComplex: BuildComplex,
    ): Compiled<Declaration> =>
      Result.gen(function* referenceType() {
        const name = yield* resolveQName(node, attribute);
        if (name.namespace === XSD_NAMESPACE) {
          const builtin = name.local;
          if (!isBuiltin(builtin)) {
            return yield* fail(node, `The built-in type xs:${builtin} is not supported.`);
          }
          const key = `builtin:${builtin}`;
          const identifier = declarations.get(key)?.identifier ?? allocate(`Xs${pascal(builtin)}`);
          return yield* declare(key, identifier, node, () =>
            buildSimple(node, builtinSpec(builtin)).pipe(Result.map(wrapBuilt(`xs:${builtin}`))),
          );
        }
        const named = name.namespace === targetNamespace ? types.get(name.local) : undefined;
        const identifier = typeIdentifiers.get(name.local);
        if (named === undefined || identifier === undefined) {
          return yield* fail(
            node,
            name.namespace === targetNamespace
              ? `The type ${name.raw} is not defined in this schema.`
              : `The type ${name.raw} belongs to the namespace ${name.namespace || "(none)"}, which is not supported.`,
          );
        }
        return yield* declare(`type:${name.local}`, identifier, named, () =>
          (named.local === "simpleType"
            ? Result.flatMap(simpleSpec(named), (spec) => buildSimple(named, spec))
            : buildComplex(named, identifier)
          ).pipe(Result.map(wrapBuilt(name.local))),
        );
      });

    const elementType = (
      node: XsdNode,
      preferred: string,
      buildComplex: BuildComplex,
    ): Compiled<Declaration> =>
      Result.gen(function* resolveElementType() {
        const constraint = node.children.find((child) =>
          ["key", "keyref", "unique"].includes(child.local),
        );
        if (constraint !== undefined) {
          return yield* fail(
            constraint,
            `xs:${constraint.local} identity constraints are not supported.`,
          );
        }
        for (const attribute of ["nillable", "abstract"]) {
          const value = node.attributes.get(attribute) ?? "false";
          if (value !== "false") {
            return yield* fail(node, `${attribute}="${value}" is not supported.`);
          }
        }
        if (node.attributes.has("fixed")) {
          return yield* fail(node, "Elements with a fixed value are not supported.");
        }
        if (node.attributes.has("type")) {
          return yield* typeReference(node, "type", buildComplex);
        }
        const inline = node.children.find(
          (child) => child.local === "simpleType" || child.local === "complexType",
        );
        if (inline === undefined) {
          return yield* fail(node, "Elements without a type (xs:anyType) are not supported.");
        }
        const key = `anonymous:${inline.path}:${String(inline.line)}`;
        const identifier = declarations.get(key)?.identifier ?? allocate(preferred);
        return yield* declare(key, identifier, inline, () =>
          inline.local === "simpleType"
            ? Result.flatMap(simpleSpec(inline), (spec) => buildSimple(inline, spec))
            : buildComplex(inline, identifier),
        );
      });

    const elementTarget = (
      node: XsdNode,
      occurs: { readonly max: number | undefined; readonly min: number },
      owner: string,
      buildComplex: BuildComplex,
    ): Compiled<{
      readonly declaration: Declaration;
      readonly declarationNode: XsdNode;
      readonly name: string;
    } | null> =>
      Result.gen(function* resolveElementTarget() {
        const name = node.attributes.get("name") ?? "";
        if (!node.attributes.has("ref")) {
          const form = node.attributes.get("form") ?? (qualified ? "qualified" : "unqualified");
          if (targetNamespace !== "" && (form === "qualified") !== qualified) {
            return yield* fail(
              node,
              `form="${form}" differs from elementFormDefault and is not supported.`,
            );
          }
          const declaration = yield* elementType(node, `${owner}${pascal(name)}`, buildComplex);
          return { declaration, declarationNode: node, name };
        }
        const reference = yield* resolveQName(node, "ref");
        const global = elements.get(reference.local);
        if (reference.namespace !== targetNamespace && occurs.min === 0) {
          notes.push(
            `${owner}: ${reference.raw} (${reference.namespace}), minOccurs 0, maxOccurs ${occurs.max === undefined ? "unbounded" : String(occurs.max)}`,
          );
          return null;
        }
        if (reference.namespace !== targetNamespace) {
          return yield* fail(
            node,
            `The required element ${reference.raw} belongs to another namespace (${reference.namespace}), which the Schema cannot represent.`,
          );
        }
        if (targetNamespace !== "" && !qualified) {
          return yield* fail(
            node,
            "A reference to a global element is namespace-qualified, but the other local elements are not: the Schema cannot represent both.",
          );
        }
        if (global === undefined) {
          return yield* fail(node, `The element ${reference.raw} is not defined in this schema.`);
        }
        if (substitutionHeads.has(reference.raw) || substitutionHeads.has(reference.local)) {
          return yield* fail(node, "Substitution groups are not supported.");
        }
        const declaration = yield* elementType(global, pascal(reference.local), buildComplex);
        return { declaration, declarationNode: global, name: reference.local };
      });

    const elementField = (
      node: XsdNode,
      owner: string,
      buildComplex: BuildComplex,
    ): Compiled<Field | null> =>
      Result.gen(function* compileElementParticle() {
        const occurs = yield* parseOccurs(node);
        const target = yield* elementTarget(node, occurs, owner, buildComplex);
        if (target === null) {
          return null;
        }
        const { declaration, declarationNode, name } = target;
        const defaultValue = declarationNode.attributes.get("default");
        if (declaration.complex && defaultValue !== undefined) {
          return yield* fail(declarationNode, "A default value needs a simple type.");
        }
        if (declaration.complex) {
          usage.set(declaration.identifier, (usage.get(declaration.identifier) ?? 0) + 1);
        }
        const type = wrap(`${owner}.${name}`, declaration.identifier);
        if (defaultValue !== undefined && occurs.min === 1 && occurs.max === 1) {
          imports.add("xsdDefaultKey");
          return {
            code: `xsdDefaultKey(${type}, ${quote(defaultValue)})`,
            name,
            optional: false,
          };
        }
        if (defaultValue !== undefined) {
          imports.add("xsdDefault");
        }
        const value =
          defaultValue === undefined ? type : `xsdDefault(${type}, ${quote(defaultValue)})`;
        const checks = [
          ...(occurs.min > 1 ? [`Schema.isMinLength(${String(occurs.min)})`] : []),
          ...(occurs.max === undefined ? [] : [`Schema.isMaxLength(${String(occurs.max)})`]),
        ];
        const code =
          occurs.max === 1
            ? value
            : `Schema.${occurs.min >= 1 ? "NonEmptyArray" : "Array"}(${value})${
                checks.length === 0 ? "" : `.check(${checks.join(", ")})`
              }`;
        return {
          code: occurs.min === 0 ? `Schema.optionalKey(${code})` : code,
          name,
          optional: occurs.min === 0,
        };
      });

    const particle = (
      node: XsdNode,
      owner: string,
      buildComplex: BuildComplex,
    ): Compiled<readonly Alternative[]> =>
      Result.gen(function* compileParticle() {
        if (node.local === "element") {
          const field = yield* elementField(node, owner, buildComplex);
          return [field === null ? [] : [field]];
        }
        if (node.local !== "sequence" && node.local !== "choice") {
          return yield* fail(node, `xs:${node.local} is not supported.`);
        }
        const occurs = yield* parseOccurs(node);
        if (occurs.max !== 1) {
          return yield* fail(node, `A repeated xs:${node.local} is not supported.`);
        }
        const alternatives = yield* Arr.reduce<XsdNode, Compiled<readonly Alternative[]>>(
          node.children,
          Result.succeed(node.local === "sequence" ? [[]] : []),
          (previous, child) =>
            Result.gen(function* expandParticle() {
              const combined = yield* previous;
              const nested = yield* particle(child, owner, buildComplex);
              const expanded =
                node.local === "sequence"
                  ? combined.flatMap((left) => nested.map((right) => [...left, ...right]))
                  : [...combined, ...nested];
              if (expanded.length > MAX_ALTERNATIVES) {
                return yield* fail(
                  node,
                  `The content model expands to more than ${String(MAX_ALTERNATIVES)} alternatives.`,
                );
              }
              return expanded;
            }),
        );
        if (alternatives.length === 0) {
          return yield* fail(node, "An empty xs:choice admits no content.");
        }
        return occurs.min === 0 &&
          !alternatives.some((alternative) => alternative.every((field) => field.optional))
          ? [...alternatives, []]
          : alternatives;
      });

    const attributeField = (
      node: XsdNode,
      owner: string,
      buildComplex: BuildComplex,
    ): Compiled<Field> =>
      Result.gen(function* compileAttribute() {
        const name = node.attributes.get("name");
        const use = node.attributes.get("use") ?? "optional";
        const form =
          node.attributes.get("form") ?? (attributesQualified ? "qualified" : "unqualified");
        if (name === undefined) {
          return yield* fail(node, "Attribute references are not supported.");
        }
        if (use !== "optional" && use !== "required") {
          return yield* fail(node, `use="${use}" is not supported.`);
        }
        if (node.attributes.has("default") || node.attributes.has("fixed")) {
          return yield* fail(node, "Attributes with a default or fixed value are not supported.");
        }
        if (form === "qualified" && targetNamespace !== "") {
          return yield* fail(node, "Namespace-qualified attributes are not supported.");
        }
        if (!node.attributes.has("type") && node.children.length === 0) {
          return yield* fail(node, "Attributes without a type are not supported.");
        }
        const declaration = yield* elementType(node, `${owner}${pascal(name)}`, buildComplex);
        if (declaration.complex) {
          return yield* fail(node, "An attribute must have a simple type.");
        }
        return {
          code:
            use === "required"
              ? declaration.identifier
              : `Schema.optionalKey(${declaration.identifier})`,
          name,
          optional: use !== "required",
        };
      });

    const buildComplex: BuildComplex = (node, owner) =>
      Result.gen(function* compileComplexType() {
        for (const attribute of ["mixed", "abstract"]) {
          if (node.attributes.get(attribute) === "true") {
            return yield* fail(node, `${attribute}="true" is not supported.`);
          }
        }
        const content = node.children.find(
          (child) => child.local === "sequence" || child.local === "choice",
        );
        const attributes: Field[] = [];
        for (const child of node.children) {
          if (child.local === "attribute") {
            attributes.push(yield* attributeField(child, owner, buildComplex));
          } else if (child !== content) {
            return yield* fail(child, `xs:${child.local} is not supported in a complex type.`);
          }
        }
        const alternatives =
          content === undefined ? [[]] : yield* particle(content, owner, buildComplex);
        const structs = new Set<string>();
        for (const alternative of alternatives) {
          const fields = [...alternative, ...attributes];
          const names = new Set<string>();
          for (const field of fields) {
            if (names.has(field.name)) {
              return yield* fail(
                node,
                `${field.name} appears twice in the same content, which the Schema cannot represent.`,
              );
            }
            names.add(field.name);
          }
          const properties = fields.map((field) =>
            indent(
              `${IDENTIFIER.test(field.name) ? field.name : quote(field.name)}: ${field.code}`,
            ),
          );
          structs.add(
            properties.length === 0
              ? "Schema.Struct({})"
              : `Schema.Struct({\n  ${properties.join(",\n  ")},\n})`,
          );
        }
        const [single] = structs;
        return {
          attributes: attributes.map((field) => field.name),
          code:
            structs.size === 1 && single !== undefined
              ? single
              : `Schema.Union([\n  ${[...structs].map(indent).join(",\n  ")},\n])`,
          complex: true,
        };
      });

    const rootElement = elements.get(options.root);
    if (rootElement === undefined) {
      return yield* fail(
        schema,
        `The global element ${options.root} does not exist. Global elements: ${[...elements.keys()].join(", ") || "(none)"}.`,
      );
    }
    if (targetNamespace === "" && options.prefix !== undefined) {
      return yield* fail(
        schema,
        "The schema has no targetNamespace, so the root cannot have a prefix.",
      );
    }
    if (targetNamespace !== "" && qualified === (options.prefix !== undefined)) {
      return yield* fail(
        schema,
        qualified
          ? 'Local elements are qualified (elementFormDefault="qualified"): the root must use the default namespace, without a prefix.'
          : "Local elements are unqualified: the root needs a prefix so that its children stay out of the target namespace.",
      );
    }
    const rootType = yield* elementType(rootElement, `${pascal(options.root)}Type`, buildComplex);
    if (!rootType.complex) {
      return yield* fail(rootElement, "The root element must have a complex type.");
    }
    if (unusedKeys.size > 0) {
      return yield* fail(
        schema,
        `No type or element that ${options.root} uses matches the override of the ${[...unusedKeys].map(describeDomainKey).join(", the ")}.`,
      );
    }

    return renderModule({
      declarations: declarations.values(),
      domainImport,
      imports,
      notes,
      options,
      rootIdentifier,
      rootType,
      targetNamespace,
      usage,
    });
  });
