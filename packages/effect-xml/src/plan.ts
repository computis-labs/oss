import { Match, Predicate, Result, SchemaAST } from "effect";
import type { Schema } from "effect";
import { getElement, getRoot } from "./annotations.ts";
import { escapeAttribute } from "./encoder.ts";
import { XmlPlanError } from "./errors/xml-plan-error.ts";
import type {
  AttributePlan,
  ChildArity,
  ChildPlan,
  ElementPlan,
  LeafPlan,
  RootPlan,
} from "./types.ts";

type NodePlan = ElementPlan | LeafPlan;

const LEAF: LeafPlan = { kind: "leaf" };
const XML_NAME = /^[\p{L}_][\p{L}\p{N}_.-]*$/u;

const at = (path: string, key: string) => (path === "" ? key : `${path}.${key}`);

const fail = (path: string, message: string) => Result.fail(new XmlPlanError({ message, path }));

const isLeafAst = (ast: SchemaAST.AST): boolean =>
  SchemaAST.isString(ast) ||
  SchemaAST.isTemplateLiteral(ast) ||
  (SchemaAST.isLiteral(ast) && Predicate.isString(ast.literal)) ||
  (SchemaAST.isEnum(ast) && ast.enums.every(([, value]) => Predicate.isString(value))) ||
  (SchemaAST.isUnion(ast) && ast.types.length > 0 && ast.types.every(isLeafAst));

const absentMember = (ast: SchemaAST.AST) =>
  SchemaAST.isUnion(ast)
    ? ast.types.find((member) => SchemaAST.isUndefined(member) || SchemaAST.isNull(member))
    : undefined;

const failAbsent = (path: string, member: SchemaAST.AST) =>
  fail(
    path,
    SchemaAST.isNull(member)
      ? "Schema.NullOr is not supported because null has no XML representation: use Schema.optionalKey."
      : "Schema.optional is not supported because undefined has no XML representation: use Schema.optionalKey.",
  );

const makeChild = (
  name: string,
  index: number,
  arity: ChildArity,
  optional: boolean,
  node: NodePlan,
): ChildPlan => ({
  arity,
  closeTag: `</${name}>`,
  index,
  name,
  node,
  openTag: `<${name}>`,
  optional,
});

const makeElement = (
  attributes: ReadonlyMap<string, AttributePlan>,
  sequence: readonly ChildPlan[],
): ElementPlan => ({
  attributes,
  children: new Map(sequence.map((child) => [child.name, child])),
  kind: "element",
  sequence,
});

const checkDeclared = (plan: ElementPlan, declared: readonly string[], path: string) => {
  const missing = declared.find((name) => !plan.attributes.has(name));
  return missing === undefined
    ? Result.succeed(plan)
    : fail(at(path, missing), `Attribute ${missing} does not exist in the schema.`);
};

const mergeElements = (
  plans: readonly ElementPlan[],
  path: string,
): Result.Result<ElementPlan, XmlPlanError> =>
  Result.gen(function* mergeUnionMembers() {
    const [first] = plans;
    if (first !== undefined && plans.every((plan) => plan === first)) {
      return first;
    }
    const predecessors = new Map<string, Set<string>>();
    const attributes = new Map<string, AttributePlan>();
    for (const plan of plans) {
      for (const [index, child] of plan.sequence.entries()) {
        const before = predecessors.get(child.name) ?? new Set<string>();
        predecessors.set(child.name, before);
        const previous = plan.sequence[index - 1];
        if (previous !== undefined) {
          before.add(previous.name);
        }
      }
      for (const [name, attribute] of plan.attributes) {
        attributes.set(name, attribute);
      }
    }

    const mergeChild = (name: string, index: number) =>
      Result.gen(function* mergeUnionChild() {
        const childPath = at(path, name);
        if (attributes.has(name)) {
          return yield* fail(
            childPath,
            `${name} is an attribute in one union member and a child element in another.`,
          );
        }
        const present = plans.flatMap((plan) => {
          const child = plan.children.get(name);
          return child === undefined ? [] : [child];
        });
        const inAll = present.length === plans.length;
        const arities = new Set(present.map((child) => child.arity));
        if (arities.has("many") && arities.size > 1) {
          return yield* fail(childPath, "The union members give this child incompatible arities.");
        }
        const single: ChildArity =
          inAll && arities.size === 1 && arities.has("one") ? "one" : "optional";
        const arity: ChildArity = arities.has("many") ? "many" : single;
        const elements = present.flatMap((child) =>
          child.node.kind === "element" ? [child.node] : [],
        );
        if (elements.length > 0 && elements.length < present.length) {
          return yield* fail(
            childPath,
            "The union members use this name for both a leaf and a structure.",
          );
        }
        const node = elements.length === 0 ? LEAF : yield* mergeElements(elements, childPath);
        const optional = !inAll || present.some((child) => child.optional);
        return makeChild(name, index, arity, optional, node);
      });

    const sequence: ChildPlan[] = [];
    const placed = new Set<string>();
    while (sequence.length < predecessors.size) {
      const next = [...predecessors].find(
        ([name, before]) => !placed.has(name) && [...before].every((item) => placed.has(item)),
      );
      if (next === undefined) {
        return yield* fail(path, "The union members order their children incompatibly.");
      }
      placed.add(next[0]);
      sequence.push(yield* mergeChild(next[0], sequence.length));
    }
    return makeElement(attributes, sequence);
  });

type CompileNode = (
  ast: SchemaAST.AST,
  path: string,
  inherited: readonly string[],
) => Result.Result<NodePlan, XmlPlanError>;

export const compile = (schema: Schema.Top): Result.Result<RootPlan, XmlPlanError> => {
  const cache = new Map<SchemaAST.AST, ElementPlan>();
  const active = new Set<SchemaAST.AST>();

  const compileUnion = (
    ast: SchemaAST.Union,
    path: string,
    declared: readonly string[],
    recur: CompileNode,
  ) =>
    Result.gen(function* compileChoice() {
      const members: ElementPlan[] = [];
      for (const member of ast.types) {
        const plan = yield* recur(member, path, declared);
        if (plan.kind === "leaf") {
          return yield* fail(path, "A union cannot mix leaves and structures.");
        }
        members.push(plan);
      }
      return yield* mergeElements(members, path);
    });

  const compileStruct = (
    ast: SchemaAST.Objects,
    path: string,
    declared: ReadonlySet<string>,
    recur: CompileNode,
  ) =>
    Result.gen(function* compileSequence() {
      if (ast.indexSignatures.length > 0) {
        return yield* fail(path, "Records and index signatures are not supported.");
      }
      const attributes = new Map<string, AttributePlan>();
      const sequence: ChildPlan[] = [];
      for (const { name, type } of ast.propertySignatures) {
        if (!Predicate.isString(name) || !XML_NAME.test(name)) {
          return yield* fail(at(path, String(name)), "The name is not a valid XML name.");
        }
        const childPath = at(path, name);
        const optional = SchemaAST.isOptional(type);
        const absent = absentMember(type);
        if (absent !== undefined) {
          return yield* failAbsent(childPath, absent);
        }
        if (declared.has(name)) {
          if (!isLeafAst(type)) {
            return yield* fail(childPath, "An attribute must be a string leaf.");
          }
          attributes.set(name, { name });
        } else if (SchemaAST.isArrays(type)) {
          const [item] = type.rest;
          const [head] = type.elements;
          if (
            item === undefined ||
            type.rest.length > 1 ||
            type.elements.length > 1 ||
            (head !== undefined && (head !== item || SchemaAST.isOptional(head)))
          ) {
            return yield* fail(
              childPath,
              "Only Array and NonEmptyArray are supported, not tuples.",
            );
          }
          const node = yield* recur(item, childPath, []);
          sequence.push(makeChild(name, sequence.length, "many", optional, node));
        } else {
          const node = yield* recur(type, childPath, []);
          const arity = optional ? "optional" : "one";
          sequence.push(makeChild(name, sequence.length, arity, optional, node));
        }
      }
      return makeElement(attributes, sequence);
    });

  const compileNode: CompileNode = (ast, path, inherited) =>
    Result.gen(function* compileSchemaNode() {
      const absent = absentMember(ast);
      if (absent !== undefined) {
        return yield* failAbsent(path, absent);
      }
      if (isLeafAst(ast)) {
        return LEAF;
      }
      const cacheable = inherited.length === 0;
      const cached = cacheable ? cache.get(ast) : undefined;
      if (cached !== undefined) {
        return cached;
      }
      if (active.has(ast)) {
        return yield* fail(path, "Recursive schemas are not supported.");
      }
      if (SchemaAST.isArrays(ast)) {
        return yield* fail(path, "Nested arrays and tuples are not supported.");
      }
      active.add(ast);
      const own = getElement(ast)?.attributes ?? [];
      const compiled: Result.Result<NodePlan, XmlPlanError> = Match.value(ast).pipe(
        Match.when(SchemaAST.isSuspend, (suspend) => compileNode(suspend.thunk(), path, inherited)),
        Match.when(SchemaAST.isUnion, (union) =>
          compileUnion(union, path, [...inherited, ...own], compileNode),
        ),
        Match.when(SchemaAST.isObjects, (objects) =>
          compileStruct(objects, path, new Set([...inherited, ...own]), compileNode),
        ),
        Match.orElse(() => fail(path, `Unsupported type: ${String(ast)}.`)),
      );
      active.delete(ast);
      const plan = yield* compiled;
      if (plan.kind === "leaf" || SchemaAST.isSuspend(ast)) {
        return plan;
      }
      const checked = yield* checkDeclared(plan, own, path);
      if (cacheable) {
        cache.set(ast, checked);
      }
      return checked;
    });

  return Result.gen(function* compileRoot() {
    const ast = SchemaAST.toEncoded(schema.ast);
    const annotation = getRoot(ast) ?? getRoot(schema.ast);
    if (annotation === undefined) {
      return yield* fail("", "The schema has no root annotation.");
    }
    const { name, namespace, prefix } = annotation;
    if (!XML_NAME.test(name)) {
      return yield* fail(name, "The root name is not a valid XML name.");
    }
    if (prefix !== undefined && (!XML_NAME.test(prefix) || namespace === undefined)) {
      return yield* fail(name, "The prefix must be a valid XML name and requires a namespace.");
    }
    const declared = annotation.attributes ?? [];
    const node = yield* compileNode(ast, name, declared);
    if (node.kind === "leaf") {
      return yield* fail(name, "The root must be a Struct or a Union of Structs.");
    }
    yield* checkDeclared(node, declared, name);
    const qualified = prefix === undefined ? name : `${prefix}:${name}`;
    const xmlns = prefix === undefined ? "xmlns" : `xmlns:${prefix}`;
    const declaration = namespace === undefined ? "" : ` ${xmlns}="${escapeAttribute(namespace)}"`;
    return {
      closeTag: `</${qualified}>`,
      name,
      namespace,
      node,
      openTagStart: `<${qualified}${declaration}`,
    };
  });
};
