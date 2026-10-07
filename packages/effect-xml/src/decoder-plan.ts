import type { XmlValue } from "./encoder.ts";
import type { AttributePlan, ElementPlan } from "./types.ts";

export interface Step {
  readonly element: Node | undefined;
  readonly index: number;
  readonly many: boolean;
  readonly name: string;
  readonly slot: number;
}

export interface Node {
  readonly attributes: ReadonlyMap<string, AttributePlan>;
  readonly children: ReadonlyMap<string, Step>;
  readonly lists: readonly Step[];
  readonly required: readonly string[];
  readonly sequence: readonly Step[];
}

export interface Frame {
  readonly child: Step | undefined;
  readonly element: Node;
  lastIndex: number;
  lists: (XmlValue[] | undefined)[] | undefined;
  readonly parent: Frame | undefined;
  readonly value: { [key: string]: XmlValue };
}

export const toNode = (plan: ElementPlan, nodes: Map<ElementPlan, Node>): Node => {
  const cached = nodes.get(plan);
  if (cached !== undefined) {
    return cached;
  }
  const lists: Step[] = [];
  const sequence: Step[] = [];
  const children = new Map<string, Step>();
  for (const child of plan.sequence) {
    const many = child.arity === "many";
    const step: Step = {
      element: child.node.kind === "element" ? toNode(child.node, nodes) : undefined,
      index: child.index,
      many,
      name: child.name,
      slot: many ? lists.length : -1,
    };
    if (many) {
      lists.push(step);
    }
    children.set(child.name, step);
    sequence.push(step);
  }
  const node: Node = {
    attributes: plan.attributes,
    children,
    lists,
    required: plan.sequence.flatMap((child) =>
      child.arity === "many" && !child.optional ? [child.name] : [],
    ),
    sequence,
  };
  nodes.set(plan, node);
  return node;
};

export const openFrame = (element: Node, child?: Step, parent?: Frame): Frame => ({
  child,
  element,
  lastIndex: -1,
  lists: undefined,
  parent,
  value: {},
});

export const store = (parent: Frame, child: Step, value: XmlValue) => {
  if (child.many) {
    parent.lists ??= [];
    const list = parent.lists[child.slot];
    if (list === undefined) {
      parent.lists[child.slot] = [value];
    } else {
      list.push(value);
    }
  } else {
    parent.value[child.name] = value;
  }
};

export const segment = (child: Step, parent: Frame | undefined) =>
  child.many ? `${child.name}[${String(parent?.lists?.[child.slot]?.length ?? 0)}]` : child.name;
