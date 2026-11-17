import type { ESTree } from "@oxlint/plugins";

import { isObject, isString } from "../predicates.ts";

type VisitorKeys = Readonly<Record<string, readonly string[]>>;

interface TypeBinding {
  readonly alias: ESTree.TSTypeAliasDeclaration | null;
  readonly name: string;
  readonly scope: ESTree.Node;
}

interface Substitution {
  readonly substitutions: Substitutions;
  readonly type: ESTree.TSType;
}

type Substitutions = ReadonlyMap<string, Substitution>;

export interface TypeAliasEnvironment {
  readonly bindingsByName: ReadonlyMap<string, readonly TypeBinding[]>;
  readonly visitorKeys: VisitorKeys;
}

const isNode = (value: unknown): value is ESTree.Node =>
  isObject(value) && "type" in value && isString(value.type);

const collectInferTypeParameterNames = (
  node: ESTree.Node,
  visitorKeys: VisitorKeys,
  names: Set<string>
): void => {
  if (node.type === "TSInferType") {
    names.add(node.typeParameter.name.name);
  }

  const fields = node as unknown as Readonly<Record<string, unknown>>;

  for (const key of visitorKeys[node.type] ?? []) {
    const value = fields[key];

    if (isNode(value)) {
      collectInferTypeParameterNames(value, visitorKeys, names);
      continue;
    }
    if (!Array.isArray(value)) {
      continue;
    }
    for (const child of value) {
      if (isNode(child)) {
        collectInferTypeParameterNames(child, visitorKeys, names);
      }
    }
  }
};

const lexicalTypeParameterNames = (
  node: ESTree.Node,
  visitorKeys: VisitorKeys
): ReadonlySet<string> => {
  const names = new Set<string>();
  let descendant: ESTree.Node = node;
  let current: ESTree.Node | null = node;

  while (current !== null && current.type !== "Program") {
    if ("typeParameters" in current) {
      for (const parameter of current.typeParameters?.params ?? []) {
        names.add(parameter.name.name);
      }
    }
    if (
      current.type === "TSMappedType" &&
      (descendant === current.nameType || descendant === current.typeAnnotation)
    ) {
      names.add(current.key.name);
    }
    if (
      current.type === "TSConditionalType" &&
      descendant === current.trueType
    ) {
      collectInferTypeParameterNames(current.extendsType, visitorKeys, names);
    }
    descendant = current;
    current = current.parent;
  }
  return names;
};

const enclosingTypeScope = (node: ESTree.Node): ESTree.Node => {
  let current: ESTree.Node | null = node.parent;

  while (current !== null) {
    if (
      current.type === "Program" ||
      current.type === "BlockStatement" ||
      current.type === "TSModuleBlock" ||
      current.type === "StaticBlock" ||
      current.type === "SwitchStatement"
    ) {
      return current;
    }
    current = current.parent;
  }
  return node;
};

const declaredTypeBinding = (
  node: ESTree.Node
): Pick<TypeBinding, "alias" | "name"> | null => {
  if (node.type === "TSTypeAliasDeclaration") {
    return { alias: node, name: node.id.name };
  }
  if (
    node.type === "TSInterfaceDeclaration" ||
    node.type === "TSEnumDeclaration" ||
    node.type === "ClassDeclaration" ||
    node.type === "ClassExpression"
  ) {
    return node.id === null ? null : { alias: null, name: node.id.name };
  }
  if (
    node.type === "ImportSpecifier" ||
    node.type === "ImportDefaultSpecifier" ||
    node.type === "ImportNamespaceSpecifier"
  ) {
    return { alias: null, name: node.local.name };
  }
  return null;
};

const collectTypeBindings = (
  node: ESTree.Node,
  visitorKeys: VisitorKeys,
  bindingsByName: Map<string, TypeBinding[]>
): void => {
  const declared = declaredTypeBinding(node);

  if (declared !== null) {
    const bindings = bindingsByName.get(declared.name) ?? [];

    bindings.push({ ...declared, scope: enclosingTypeScope(node) });
    bindingsByName.set(declared.name, bindings);
  }

  const fields = node as unknown as Readonly<Record<string, unknown>>;

  for (const key of visitorKeys[node.type] ?? []) {
    const value = fields[key];

    if (isNode(value)) {
      collectTypeBindings(value, visitorKeys, bindingsByName);
      continue;
    }
    if (!Array.isArray(value)) {
      continue;
    }
    for (const child of value) {
      if (isNode(child)) {
        collectTypeBindings(child, visitorKeys, bindingsByName);
      }
    }
  }
};

export const createTypeAliasEnvironment = (
  program: ESTree.Program,
  visitorKeys: VisitorKeys
): TypeAliasEnvironment => {
  const bindingsByName = new Map<string, TypeBinding[]>();

  collectTypeBindings(program, visitorKeys, bindingsByName);
  return { bindingsByName, visitorKeys };
};

const ancestorDistance = (
  ancestor: ESTree.Node,
  node: ESTree.Node
): number | null => {
  let current: ESTree.Node | null = node;
  let distance = 0;

  while (current !== null) {
    if (current === ancestor) {
      return distance;
    }
    current = current.parent;
    distance += 1;
  }
  return null;
};

const visibleTypeAlias = (
  name: string,
  use: ESTree.Node,
  environment: TypeAliasEnvironment
): ESTree.TSTypeAliasDeclaration | null => {
  if (lexicalTypeParameterNames(use, environment.visitorKeys).has(name)) {
    return null;
  }

  const candidates = environment.bindingsByName.get(name) ?? [];
  let nearestDistance = Number.POSITIVE_INFINITY;
  let nearest: TypeBinding[] = [];

  for (const candidate of candidates) {
    const distance = ancestorDistance(candidate.scope, use);

    if (distance === null || distance > nearestDistance) {
      continue;
    }
    if (distance === nearestDistance) {
      nearest.push(candidate);
      continue;
    }
    nearestDistance = distance;
    nearest = [candidate];
  }
  return nearest.length === 1 ? (nearest[0]?.alias ?? null) : null;
};

const aliasSubstitutions = (
  alias: ESTree.TSTypeAliasDeclaration,
  reference: ESTree.TSTypeReference,
  base: Substitutions
): Substitutions | null => {
  const parameters = alias.typeParameters?.params ?? [];
  const arguments_ = reference.typeArguments?.params ?? [];
  const next = new Map(base);

  for (const [index, parameter] of parameters.entries()) {
    const explicitArgument = arguments_[index];
    const argument = explicitArgument ?? parameter.default;

    if (argument === null || argument === undefined) {
      return null;
    }

    const argumentSubstitutions = explicitArgument === undefined ? next : base;

    next.set(parameter.name.name, {
      substitutions: new Map(argumentSubstitutions),
      type: argument,
    });
  }
  return next;
};

export const resolvedTypeMatches = (
  type: ESTree.TSType,
  environment: TypeAliasEnvironment,
  matcher: (
    type: ESTree.TSType,
    matches: (child: ESTree.TSType) => boolean
  ) => boolean
): boolean => {
  const evaluate = (
    current: ESTree.TSType,
    substitutions: Substitutions,
    resolvingAliases: ReadonlySet<ESTree.TSTypeAliasDeclaration>
  ): boolean => {
    if (
      current.type === "TSTypeReference" &&
      current.typeName.type === "Identifier"
    ) {
      const name = current.typeName.name;
      const substitution = substitutions.get(name);

      if (
        substitution !== undefined &&
        (current.typeArguments?.params.length ?? 0) === 0
      ) {
        return evaluate(
          substitution.type,
          substitution.substitutions,
          resolvingAliases
        );
      }

      const alias = visibleTypeAlias(name, current, environment);

      if (alias !== null && !resolvingAliases.has(alias)) {
        const nextSubstitutions = aliasSubstitutions(
          alias,
          current,
          substitutions
        );

        if (nextSubstitutions !== null) {
          const nextResolving = new Set(resolvingAliases);

          nextResolving.add(alias);
          return evaluate(
            alias.typeAnnotation,
            nextSubstitutions,
            nextResolving
          );
        }
      }
    }
    return matcher(current, (child) =>
      evaluate(child, substitutions, resolvingAliases)
    );
  };

  return evaluate(type, new Map(), new Set());
};
