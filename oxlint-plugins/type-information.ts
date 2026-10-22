import { API, SignatureKind, TypeFlags } from "typescript/unstable/sync";
import type { Checker, Project, Snapshot, Type } from "typescript/unstable/sync";
import {
  isFunctionDeclaration,
  isInterfaceDeclaration,
  isMethodSignatureDeclaration,
  isVariableDeclaration,
} from "typescript/unstable/ast/is";
import type { ESTree } from "@oxlint/plugins";
import type { Node } from "typescript/unstable/ast";

let api: API | undefined;
let snapshot: Snapshot | undefined;

export const projectFor = (filename: string) => {
  api ??= new API();
  const existing = snapshot
    ?.getProjects()
    .find((project) => project.program.getSourceFileMetadata(filename) !== undefined);
  if (existing !== undefined) {
    return existing;
  }
  const previous = snapshot;
  snapshot = api.updateSnapshot({ openFiles: [filename] });
  previous?.dispose();
  const project = snapshot.getDefaultProjectForFile(filename);
  if (project === undefined) {
    throw new Error(`Cannot resolve the TypeScript project for ${filename}.`);
  }
  return project;
};

const syntaxNodes = new WeakMap<Project, Map<string, Map<string, Node>>>();

export const typeAt = (project: Project, filename: string, node: ESTree.Node) => {
  let files = syntaxNodes.get(project);
  if (files === undefined) {
    files = new Map();
    syntaxNodes.set(project, files);
  }
  let nodes = files.get(filename);
  if (nodes === undefined) {
    nodes = new Map();
    const collect = (syntax: Node) => {
      nodes?.set(`${syntax.getStart()}:${syntax.end}`, syntax);
      syntax.forEachChild(collect);
    };
    const source = project.program.getSourceFile(filename);
    if (source === undefined) {
      throw new Error(`Cannot read TypeScript syntax for ${filename}.`);
    }
    collect(source);
    files.set(filename, nodes);
  }
  const syntax = nodes.get(`${node.start}:${node.end}`);
  return syntax === undefined
    ? project.checker.getTypeAtPosition(filename, node.end - 1)
    : project.checker.getTypeAtLocation(syntax);
};

export const typeOfTypeNode = (project: Project, filename: string, node: ESTree.Node) => {
  let syntax: Node | undefined = project.program.getSourceFile(filename);
  while (syntax !== undefined && (syntax.getStart() !== node.start || syntax.end !== node.end)) {
    syntax = syntax.forEachChild((child) =>
      child.getStart() <= node.start && node.end <= child.end ? child : undefined,
    );
  }
  return syntax === undefined ? undefined : project.checker.getTypeFromTypeNode(syntax);
};

export const isUnresolved = (
  checker: Checker,
  type: Type | undefined,
  visited = new Set<number>(),
): boolean => {
  if (type === undefined) {
    return true;
  }
  if (visited.has(type.id)) {
    return false;
  }
  visited.add(type.id);
  if (type.flags === TypeFlags.Any || type.flags === TypeFlags.Unknown) {
    return true;
  }
  if (type.isTypeParameter()) {
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint !== undefined && isUnresolved(checker, constraint, visited);
  }
  if (type.isUnionType() || type.isIntersectionType()) {
    return type.getTypes().some((member) => isUnresolved(checker, member, visited));
  }
  return checker
    .getIndexInfosOfType(type)
    .some((index) => isUnresolved(checker, index.valueType, visited));
};

export const isStandardLibrary = (filename: string) =>
  filename.startsWith("bundled:///libs/lib.") || filename.includes("/typescript/lib/lib.");

export const libraryCheck = (
  project: Project,
  filename: string,
  callee: ESTree.Expression,
): string | null => {
  const type = typeAt(project, filename, callee);
  if (type === undefined) {
    return null;
  }
  for (const signature of project.checker.getSignaturesOfType(type, SignatureKind.Call)) {
    const { declaration } = signature;
    const node = declaration?.resolve();
    if (declaration === undefined || node === undefined) {
      continue;
    }
    if (/\/effect\/dist\/(?:dts\/)?predicate\.d\.ts$/u.test(declaration.path.toLowerCase())) {
      // v3 exported the predicates as `const`; v4 declares them as functions.
      if (isVariableDeclaration(node.parent)) {
        return `Predicate.${node.parent.name.getText()}`;
      }
      if (isFunctionDeclaration(node) && node.name !== undefined) {
        return `Predicate.${node.name.getText()}`;
      }
    }
    if (!isStandardLibrary(declaration.path)) {
      continue;
    }
    if (isMethodSignatureDeclaration(node) && isInterfaceDeclaration(node.parent)) {
      const owner = node.parent.name.getText();
      const method = node.name.getText();
      if (owner === "JSON" && method === "parse") {
        return "JSON.parse";
      }
      if (owner === "ArrayConstructor" && method === "isArray") {
        return "Array.isArray";
      }
    }
    if (isInterfaceDeclaration(node.parent) && node.parent.name.getText() === "StringConstructor") {
      return "String";
    }
  }
  return null;
};
