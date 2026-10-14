import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseSync } from "oxc-parser";

import { isNumber, isRecord, isString } from "./predicates.ts";

import type { ESTree } from "@oxlint/plugins";

export interface SourceModule {
  readonly ast: ESTree.Program;
  readonly path: string;
}

/** A literal-union type backed by a named `as const` lookup table. */
export interface EnumOwner {
  /** Value -> member path on the owner, e.g. "waiting" -> "waiting", "TD01" -> "TD01.code". */
  readonly members: ReadonlyMap<string, string>;
  /** Identifier of the object that owns the values, e.g. `invoiceStatuses`. */
  readonly name: string;
  /** Module that declares the owner, used to tell callers what to import. */
  readonly path: string;
}

export interface TypeReference {
  readonly module: SourceModule;
  readonly type: ESTree.TSType | ESTree.TSTypeAnnotation;
}

type ValueDeclaration = ESTree.VariableDeclarator | ESTree.Function;
type TypeDeclaration = ESTree.TSTypeAliasDeclaration | ESTree.TSInterfaceDeclaration;
type Reader<T> = (module: SourceModule, name: string) => T | null;

interface Resolved<T> {
  readonly module: SourceModule;
  readonly node: T;
}

const MAX_DEPTH = 8;
const MAX_VISITED = 64;
const SOURCE_EXTENSIONS = [".ts", ".tsx", "/index.ts", "/index.tsx"];
const EXPORT_CONDITIONS = ["source", "import", "default"];
const WORKSPACE_GROUPS = ["apps", "packages"];

const moduleCache = new Map<string, SourceModule | null>();
const packageCache = new Map<string, string | null>();
const manifestCache = new Map<string, Record<string, unknown> | null>();
const ownerCache = new Map<string, EnumOwner | null>();
const tableCache = new Map<string, ReadonlyMap<string, EnumOwner> | null>();

/**
 * oxc-parser and @oxlint/plugins bundle the same ESTree shape under two package copies, so
 * the nominal types never meet. Checking the root tag is the honest way across that boundary.
 */
const isProgram = (value: unknown): value is ESTree.Program =>
  isRecord(value) && value.type === "Program";

const readManifest = (file: string) => {
  const cached = manifestCache.get(file);
  if (cached !== undefined) {
    return cached;
  }

  let manifest: Record<string, unknown> | null = null;
  try {
    const contents: unknown = JSON.parse(readFileSync(file, "utf-8"));
    manifest = isRecord(contents) ? contents : null;
  } catch {
    manifest = null;
  }

  manifestCache.set(file, manifest);
  return manifest;
};

/** Nearest directory at or above `from` that holds a package.json. */
const packageDirectory = (from: string): string | null => {
  const cached = packageCache.get(from);
  if (cached !== undefined) {
    return cached;
  }

  let current = from;
  let found: string | null = null;
  while (current !== path.dirname(current)) {
    if (existsSync(path.join(current, "package.json"))) {
      found = current;
      break;
    }
    current = path.dirname(current);
  }

  packageCache.set(from, found);
  return found;
};

const workspaceRoot = (from: string): string | null => {
  let current = packageDirectory(from);
  let outermost: string | null = null;

  while (current !== null) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    outermost = current;
    const parent = path.dirname(current);
    current = parent === current ? null : packageDirectory(parent);
  }

  return outermost;
};

const withSourceExtension = (base: string): string | null => {
  if (/\.tsx?$/u.test(base) && existsSync(base)) {
    return base;
  }

  const stripped = base.replace(/\.(?:js|jsx|ts|tsx)$/u, "");
  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = `${stripped}${extension}`;
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
};

/** Picks the first matching condition of a package.json subpath target. */
const conditionTarget = (target: unknown): string | null => {
  if (isString(target)) {
    return target;
  }
  if (!isRecord(target)) {
    return null;
  }

  for (const condition of EXPORT_CONDITIONS) {
    const value = target[condition];
    if (isString(value)) {
      return value;
    }
  }

  return null;
};

/** Applies a package.json `imports`/`exports` map, wildcards included. */
const applySubpathMap = (
  map: Record<string, unknown>,
  specifier: string,
  packageDir: string,
): string | null => {
  const exact = conditionTarget(map[specifier]);
  if (exact !== null) {
    return path.resolve(packageDir, exact);
  }

  for (const [pattern, target] of Object.entries(map)) {
    const star = pattern.indexOf("*");
    if (star === -1) {
      continue;
    }

    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
      continue;
    }

    const resolved = conditionTarget(target);
    if (resolved !== null) {
      const rest = specifier.slice(prefix.length, specifier.length - suffix.length);
      return path.resolve(packageDir, resolved.replace("*", rest));
    }
  }

  return null;
};

const resolveSubpathImport = (specifier: string, packageDir: string): string | null => {
  const manifest = readManifest(path.join(packageDir, "package.json"));
  const imports = manifest?.imports;
  if (!isRecord(imports)) {
    return null;
  }

  const target = applySubpathMap(imports, specifier, packageDir);
  return target === null ? null : withSourceExtension(target);
};

const resolveWorkspaceExport = (specifier: string, fromFile: string): string | null => {
  const root = workspaceRoot(fromFile);
  if (root === null) {
    return null;
  }

  const [scope, name, ...rest] = specifier.split("/");
  if (scope === undefined || name === undefined) {
    return null;
  }

  const packageName = `${scope}/${name}`;
  for (const group of WORKSPACE_GROUPS) {
    const candidateDir = path.join(root, group, name);
    const manifest = readManifest(path.join(candidateDir, "package.json"));
    if (manifest?.name !== packageName) {
      continue;
    }

    const { exports } = manifest;
    if (!isRecord(exports)) {
      return null;
    }

    const subpath = rest.length === 0 ? "." : `./${rest.join("/")}`;
    const target = applySubpathMap(exports, subpath, candidateDir);
    return target === null ? null : withSourceExtension(target);
  }

  return null;
};

/** Resolves an import specifier to a source file, honouring workspace subpath maps. */
export const resolveSpecifier = (specifier: string, fromFile: string): string | null => {
  if (specifier.startsWith(".")) {
    return withSourceExtension(path.resolve(path.dirname(fromFile), specifier));
  }

  const packageDir = packageDirectory(fromFile);
  if (packageDir === null) {
    return null;
  }

  if (specifier.startsWith("#")) {
    return resolveSubpathImport(specifier, packageDir);
  }

  if (specifier.startsWith("@/")) {
    return withSourceExtension(path.join(packageDir, "src", specifier.slice(2)));
  }

  return specifier.startsWith("@") ? resolveWorkspaceExport(specifier, fromFile) : null;
};

export const loadModule = (file: string): SourceModule | null => {
  const cached = moduleCache.get(file);
  if (cached !== undefined) {
    return cached;
  }

  let parsed: SourceModule | null = null;
  try {
    const result = parseSync(file, readFileSync(file, "utf-8"));
    const program: unknown = result.program;
    parsed = result.errors.length > 0 || !isProgram(program) ? null : { ast: program, path: file };
  } catch {
    parsed = null;
  }

  moduleCache.set(file, parsed);
  return parsed;
};

/** Strips parentheses and annotation wrappers from a type node. */
export const bareType = (node: ESTree.TSType | ESTree.TSTypeAnnotation | null | undefined) => {
  let current: ESTree.TSType | ESTree.TSTypeAnnotation | null | undefined = node;

  while (current?.type === "TSTypeAnnotation" || current?.type === "TSParenthesizedType") {
    current = current.typeAnnotation;
  }

  return current ?? null;
};

/** Strips casts and parentheses from an expression. */
export const bareExpression = (node: ESTree.Node | null | undefined) => {
  let current = node;

  while (
    current?.type === "TSAsExpression" ||
    current?.type === "TSSatisfiesExpression" ||
    current?.type === "ParenthesizedExpression" ||
    current?.type === "TSNonNullExpression"
  ) {
    current = current.expression;
  }

  return current ?? null;
};

/** Static name of an object property or signature key. */
export const propertyName = (key: ESTree.Node): string | null => {
  if (key.type === "Identifier") {
    return key.name;
  }
  if (key.type !== "Literal") {
    return null;
  }

  const { value } = key;
  if (isString(value)) {
    return value;
  }
  return isNumber(value) ? String(value) : null;
};

/** Local name behind an import or export specifier. */
const specifierName = (node: ESTree.Node): string | null => {
  if (node.type === "Identifier") {
    return node.name;
  }
  return node.type === "Literal" && isString(node.value) ? node.value : null;
};

const declarationOf = (statement: ESTree.Node): ESTree.Node | null =>
  statement.type === "ExportNamedDeclaration" ? (statement.declaration ?? null) : statement;

const localValue: Reader<ValueDeclaration> = (module, name) => {
  for (const statement of module.ast.body) {
    const declaration = declarationOf(statement);

    if (declaration?.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations) {
        if (declarator.id.type === "Identifier" && declarator.id.name === name) {
          return declarator;
        }
      }
    }

    if (declaration?.type === "FunctionDeclaration" && declaration.id?.name === name) {
      return declaration;
    }
  }

  return null;
};

const localType: Reader<TypeDeclaration> = (module, name) => {
  for (const statement of module.ast.body) {
    const declaration = declarationOf(statement);
    const isTypeDeclaration =
      declaration?.type === "TSTypeAliasDeclaration" ||
      declaration?.type === "TSInterfaceDeclaration";

    if (isTypeDeclaration && declaration.id.name === name) {
      return declaration;
    }
  }

  return null;
};

/** Follows `export * from` and `export { x } from` chains. */
const findExported = <T>(
  module: SourceModule,
  name: string,
  read: Reader<T>,
  visited: Set<string>,
): Resolved<T> | null => {
  const key = `${module.path}\u0000${name}`;
  if (visited.has(key) || visited.size > MAX_VISITED) {
    return null;
  }
  visited.add(key);

  const direct = read(module, name);
  if (direct !== null) {
    return { module, node: direct };
  }

  for (const statement of module.ast.body) {
    const isReExport =
      statement.type === "ExportAllDeclaration" ||
      (statement.type === "ExportNamedDeclaration" && statement.source !== null);
    if (!isReExport) {
      continue;
    }

    const source =
      statement.type === "ExportNamedDeclaration" ? statement.source : statement.source;
    if (source === null || source === undefined) {
      continue;
    }

    let lookup = name;
    if (statement.type === "ExportNamedDeclaration") {
      const match = statement.specifiers.find((entry) => specifierName(entry.exported) === name);
      const local = match === undefined ? null : specifierName(match.local);
      if (local === null) {
        continue;
      }
      lookup = local;
    }

    const file = resolveSpecifier(source.value, module.path);
    const next = file === null ? null : loadModule(file);
    const found = next === null ? null : findExported(next, lookup, read, visited);
    if (found !== null) {
      return found;
    }
  }

  return null;
};

/** Resolves `name` in `module`, following its imports when the binding is not local. */
const resolveBinding = <T>(module: SourceModule, name: string, read: Reader<T>) => {
  for (const statement of module.ast.body) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }

    for (const specifier of statement.specifiers) {
      if (specifier.local.name !== name) {
        continue;
      }
      if (specifier.type !== "ImportSpecifier") {
        return null;
      }

      const file = resolveSpecifier(statement.source.value, module.path);
      const target = file === null ? null : loadModule(file);
      const imported = specifierName(specifier.imported);
      if (target === null || imported === null) {
        return null;
      }

      return findExported(target, imported, read, new Set());
    }
  }

  return findExported(module, name, read, new Set());
};

export const resolveValue = (module: SourceModule, name: string) =>
  resolveBinding(module, name, localValue);

const resolveTypeName = (module: SourceModule, name: string) =>
  resolveBinding(module, name, localType);

const objectInitializer = (declarator: ValueDeclaration | null) => {
  if (declarator === null || declarator.type !== "VariableDeclarator") {
    return null;
  }

  const object = bareExpression(declarator.init);
  return object?.type === "ObjectExpression" ? object : null;
};

/** String literal held under `key` in an entry object, e.g. `{ code: "TD01" }`. */
const entryCode = (entry: ESTree.ObjectExpression): string | null => {
  for (const property of entry.properties) {
    if (property.type !== "Property" || property.computed) {
      continue;
    }

    const value = bareExpression(property.value);
    if (
      propertyName(property.key) === "code" &&
      value?.type === "Literal" &&
      isString(value.value)
    ) {
      return value.value;
    }
  }

  return null;
};

/** Reads `{ a: "a" }` and `{ TD01: { code: "TD01" } }` into value -> member path. */
const constObjectMembers = (
  declarator: ValueDeclaration | null,
): ReadonlyMap<string, string> | null => {
  const object = objectInitializer(declarator);
  if (object === null) {
    return null;
  }

  const members = new Map<string, string>();
  for (const property of object.properties) {
    if (property.type !== "Property" || property.computed) {
      continue;
    }

    const key = propertyName(property.key);
    if (key === null) {
      continue;
    }

    const value = bareExpression(property.value);
    if (value?.type === "Literal" && isString(value.value)) {
      members.set(value.value, key);
      continue;
    }

    const code = value?.type === "ObjectExpression" ? entryCode(value) : null;
    if (code !== null) {
      members.set(code, `${key}.code`);
    }
  }

  return members.size === 0 ? null : members;
};

const ownerFromObject = (module: SourceModule, name: string): EnumOwner | null => {
  const resolved = resolveValue(module, name);
  if (resolved === null) {
    return null;
  }

  const members = constObjectMembers(resolved.node);
  return members === null ? null : { members, name, path: resolved.module.path };
};

/** Single owner referenced by every element of `[owner.a, owner.b] as const`. */
const ownerFromConstArray = (declarator: ValueDeclaration | null, module: SourceModule) => {
  if (declarator === null || declarator.type !== "VariableDeclarator") {
    return null;
  }

  const array = bareExpression(declarator.init);
  if (array?.type !== "ArrayExpression") {
    return null;
  }

  const names = new Set<string>();
  for (const element of array.elements) {
    const value = bareExpression(element);
    if (value?.type !== "MemberExpression" || value.computed) {
      return null;
    }
    if (value.object.type !== "Identifier") {
      return null;
    }
    names.add(value.object.name);
  }

  if (names.size !== 1) {
    return null;
  }

  const [name] = [...names];
  return name === undefined ? null : ownerFromObject(module, name);
};

/**
 * Keys of an `as const` table, mapped to whichever member re-states the key as a literal.
 * Keeps the replacement typed as that key instead of the whole entry object.
 */
const ownerFromKeys = (module: SourceModule, name: string): EnumOwner | null => {
  const resolved = resolveValue(module, name);
  const object = resolved === null ? null : objectInitializer(resolved.node);
  if (object === null || resolved === null) {
    return null;
  }

  const members = new Map<string, string>();
  for (const property of object.properties) {
    if (property.type !== "Property" || property.computed) {
      continue;
    }

    const key = propertyName(property.key);
    if (key === null) {
      continue;
    }

    const value = bareExpression(property.value);
    if (value?.type === "Literal" && value.value === key) {
      members.set(key, key);
      continue;
    }

    const code = value?.type === "ObjectExpression" ? entryCode(value) : null;
    if (code === key) {
      members.set(key, `${key}.code`);
    }
  }

  return members.size === 0 ? null : { members, name, path: resolved.module.path };
};

const queriedName = (node: ESTree.TSType | null): string | null => {
  const query = bareType(node);
  if (query?.type !== "TSTypeQuery") {
    return null;
  }
  return query.exprName.type === "Identifier" ? query.exprName.name : null;
};

const ownerFromIndexedAccess = (node: ESTree.TSIndexedAccessType, module: SourceModule) => {
  const name = queriedName(node.objectType);
  if (name === null) {
    return null;
  }

  // `(typeof codes)[number]` walks the array; `typeof table[keyof typeof table]` walks values.
  if (bareType(node.indexType)?.type === "TSNumberKeyword") {
    return ownerFromConstArray(resolveValue(module, name)?.node ?? null, module);
  }

  return ownerFromObject(module, name);
};

/**
 * Single owner behind `Status | undefined` and similar nullable wrappers. Takes the
 * recursion as an argument so it can sit above `enumOwnerOfType`.
 */
const ownerFromUnion = (
  node: ESTree.TSUnionType,
  ownerOfEntry: (entry: ESTree.TSType) => EnumOwner | null,
): EnumOwner | null => {
  const owners: EnumOwner[] = [];
  let optionalMembers = 0;

  for (const entry of node.types) {
    const kind = bareType(entry)?.type;
    if (kind === "TSNullKeyword" || kind === "TSUndefinedKeyword") {
      optionalMembers += 1;
      continue;
    }

    const owner = ownerOfEntry(entry);
    if (owner === null) {
      return null;
    }
    owners.push(owner);
  }

  const isSingleOwner =
    owners.length === 1 && owners.length + optionalMembers === node.types.length;
  return isSingleOwner ? (owners[0] ?? null) : null;
};

/**
 * Maps a type node to the constant object that owns its values, when the type is a
 * literal union derived from an `as const` lookup table.
 */
export const enumOwnerOfType = (
  type: ESTree.TSType | ESTree.TSTypeAnnotation | null | undefined,
  module: SourceModule,
  depth = 0,
): EnumOwner | null => {
  const node = bareType(type);
  if (node === null || depth > MAX_DEPTH) {
    return null;
  }

  if (node.type === "TSTypeReference" && node.typeName.type === "Identifier") {
    const key = `${module.path}\u0000${node.typeName.name}`;
    const cached = ownerCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    ownerCache.set(key, null);

    const resolved = resolveTypeName(module, node.typeName.name);
    const owner =
      resolved?.node.type === "TSTypeAliasDeclaration"
        ? enumOwnerOfType(resolved.node.typeAnnotation, resolved.module, depth + 1)
        : null;
    ownerCache.set(key, owner);
    return owner;
  }

  if (node.type === "TSIndexedAccessType") {
    return ownerFromIndexedAccess(node, module);
  }

  if (node.type === "TSTypeOperator" && node.operator === "keyof") {
    const name = queriedName(node.typeAnnotation);
    return name === null ? null : ownerFromKeys(module, name);
  }

  return node.type === "TSUnionType"
    ? ownerFromUnion(node, (entry) => enumOwnerOfType(entry, module, depth + 1))
    : null;
};

const signatureMembers = (
  signatures: readonly ESTree.TSSignature[],
  module: SourceModule,
): ReadonlyMap<string, TypeReference> | null => {
  const members = new Map<string, TypeReference>();

  for (const signature of signatures) {
    if (signature.type !== "TSPropertySignature" || signature.computed) {
      continue;
    }

    const key = propertyName(signature.key);
    if (key !== null && signature.typeAnnotation !== null) {
      members.set(key, { module, type: signature.typeAnnotation });
    }
  }

  return members.size === 0 ? null : members;
};

/** Property name -> declared type, for object-shaped annotations. */
export const membersOfType = (
  type: ESTree.TSType | ESTree.TSTypeAnnotation | null | undefined,
  module: SourceModule,
  depth = 0,
): ReadonlyMap<string, TypeReference> | null => {
  const node = bareType(type);
  if (node === null || depth > MAX_DEPTH) {
    return null;
  }

  if (node.type === "TSTypeLiteral") {
    return signatureMembers(node.members, module);
  }

  if (node.type === "TSTypeReference" && node.typeName.type === "Identifier") {
    const resolved = resolveTypeName(module, node.typeName.name);
    if (resolved === null) {
      return null;
    }
    if (resolved.node.type === "TSInterfaceDeclaration") {
      return signatureMembers(resolved.node.body.body, resolved.module);
    }
    return membersOfType(resolved.node.typeAnnotation, resolved.module, depth + 1);
  }

  if (node.type === "TSUnionType") {
    for (const entry of node.types) {
      const members = membersOfType(entry, module, depth + 1);
      if (members !== null) {
        return members;
      }
    }
  }

  return null;
};

/** Element type of an array-shaped annotation. */
export const elementOfType = (
  type: ESTree.TSType | ESTree.TSTypeAnnotation | null | undefined,
  module: SourceModule,
  depth = 0,
): TypeReference | null => {
  const node = bareType(type);
  if (node === null || depth > MAX_DEPTH) {
    return null;
  }

  if (node.type === "TSArrayType") {
    return { module, type: node.elementType };
  }

  if (node.type === "TSTypeOperator" && node.operator === "readonly") {
    return elementOfType(node.typeAnnotation, module, depth + 1);
  }

  if (node.type === "TSTypeReference" && node.typeName.type === "Identifier") {
    const parameter = node.typeArguments?.params[0];
    const isArrayAlias = node.typeName.name === "Array" || node.typeName.name === "ReadonlyArray";
    if (isArrayAlias && parameter !== undefined) {
      return { module, type: parameter };
    }

    const resolved = resolveTypeName(module, node.typeName.name);
    return resolved?.node.type === "TSTypeAliasDeclaration"
      ? elementOfType(resolved.node.typeAnnotation, resolved.module, depth + 1)
      : null;
  }

  if (node.type === "TSUnionType") {
    for (const entry of node.types) {
      const element = elementOfType(entry, module, depth + 1);
      if (element !== null) {
        return element;
      }
    }
  }

  return null;
};

/** Unwinds `column("x").notNull().default(...)` to the `column("x")` call. */
export const columnBuilderCall = (node: ESTree.Node | null) => {
  let current = node;

  while (current?.type === "CallExpression" && current.callee.type === "MemberExpression") {
    current = current.callee.object;
  }

  return current?.type === "CallExpression" ? current : null;
};

const isPgEnumCallee = (callee: ESTree.Node) => {
  if (callee.type === "Identifier") {
    return callee.name === "pgEnum";
  }

  return (
    callee.type === "MemberExpression" &&
    callee.property.type === "Identifier" &&
    callee.property.name === "pgEnum"
  );
};

/** Owner behind `pgEnum("name", [owner.a, owner.b])`. */
export const enumOwnerOfPgEnum = (declarator: ValueDeclaration | null, module: SourceModule) => {
  if (declarator === null || declarator.type !== "VariableDeclarator") {
    return null;
  }

  const call = bareExpression(declarator.init);
  if (call?.type !== "CallExpression" || !isPgEnumCallee(call.callee)) {
    return null;
  }

  const [, values] = call.arguments;
  if (values?.type !== "ArrayExpression") {
    return null;
  }

  const names = new Set<string>();
  for (const element of values.elements) {
    const value = bareExpression(element);
    if (value?.type !== "MemberExpression" || value.object.type !== "Identifier") {
      return null;
    }
    names.add(value.object.name);
  }

  if (names.size !== 1) {
    return null;
  }

  const [name] = [...names];
  return name === undefined ? null : ownerFromObject(module, name);
};

const pgTableColumns = (declarator: ValueDeclaration) => {
  if (declarator.type !== "VariableDeclarator") {
    return null;
  }

  const call = bareExpression(declarator.init);
  const isPgTable =
    call?.type === "CallExpression" &&
    call.callee.type === "Identifier" &&
    call.callee.name === "pgTable";
  if (!isPgTable) {
    return null;
  }

  const [, columns] = call.arguments;
  return columns?.type === "ObjectExpression" ? columns : null;
};

/** Column name -> enum owner, for a `pgTable` declared in or imported by `module`. */
export const enumColumnsOfTable = (
  module: SourceModule,
  tableName: string,
): ReadonlyMap<string, EnumOwner> | null => {
  const key = `${module.path}\u0000${tableName}`;
  const cached = tableCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  tableCache.set(key, null);

  const resolved = resolveValue(module, tableName);
  const declarations = resolved === null ? null : pgTableColumns(resolved.node);
  if (declarations === null || resolved === null) {
    return null;
  }

  const columns = new Map<string, EnumOwner>();
  for (const property of declarations.properties) {
    if (property.type !== "Property" || property.computed) {
      continue;
    }

    const name = propertyName(property.key);
    const builder = columnBuilderCall(bareExpression(property.value));
    if (name === null || builder === null || builder.callee.type !== "Identifier") {
      continue;
    }

    const declaration = resolveValue(resolved.module, builder.callee.name);
    const owner =
      declaration === null ? null : enumOwnerOfPgEnum(declaration.node, declaration.module);
    if (owner !== null) {
      columns.set(name, owner);
    }
  }

  const result = columns.size === 0 ? null : columns;
  tableCache.set(key, result);
  return result;
};
