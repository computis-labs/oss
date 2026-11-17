import { Data } from "effect";

export interface Span {
  readonly start: number;
  readonly end: number;
}

export const Roles = {
  assistant: "assistant",
  system: "system",
  user: "user",
} as const;

export type Role = (typeof Roles)[keyof typeof Roles];

export const DataVariables = {
  first: "first",
  index: "index",
  last: "last",
} as const;

export type DataVariable = (typeof DataVariables)[keyof typeof DataVariables];

export type LiteralValue = string | number | boolean | null;

export type Expression = Data.TaggedEnum<{
  Path: {
    readonly root: string;
    readonly segments: readonly string[];
    readonly span: Span;
  };
  Data: { readonly name: DataVariable; readonly span: Span };
  Literal: {
    readonly value: LiteralValue;
    readonly span: Span;
  };
}>;

export type LiteralExpression = Data.TaggedEnum.Value<Expression, "Literal">;

export type ValueExpression = Exclude<Expression, LiteralExpression>;

export const Expressions = Data.taggedEnum<Expression>();

export interface HashArgument {
  readonly name: string;
  readonly value: Expression;
  readonly span: Span;
}

export const ComparisonOperators = {
  equals: "==",
  notEquals: "!=",
} as const;

export type ComparisonOperator =
  (typeof ComparisonOperators)[keyof typeof ComparisonOperators];

export type Condition = Data.TaggedEnum<{
  Truthy: {
    readonly value: ValueExpression;
    readonly span: Span;
  };
  Compare: {
    readonly operator: ComparisonOperator;
    readonly left: ValueExpression;
    readonly right: LiteralExpression;
    readonly span: Span;
  };
  Not: {
    readonly condition: Condition;
    readonly span: Span;
  };
}>;

export interface IfBranch {
  readonly condition: Condition;
  readonly body: readonly Node[];
  readonly span: Span;
}

export const Conditions = Data.taggedEnum<Condition>();

export type Node = Data.TaggedEnum<{
  Text: { readonly value: string; readonly span: Span };
  Output: {
    readonly value: ValueExpression;
    readonly span: Span;
  };
  Helper: {
    readonly name: string;
    readonly args: readonly Expression[];
    readonly hash: readonly HashArgument[];
    readonly span: Span;
  };
  If: {
    readonly branches: readonly [IfBranch, ...IfBranch[]];
    readonly alternate: readonly Node[];
    readonly span: Span;
  };
  Each: {
    readonly iterable: ValueExpression;
    readonly item: string;
    readonly index?: string;
    readonly body: readonly Node[];
    readonly alternate: readonly Node[];
    readonly span: Span;
  };
  Partial: {
    readonly source: string;
    readonly hash: readonly HashArgument[];
    readonly indent: string;
    readonly span: Span;
  };
}>;

export interface Message {
  readonly role: Role;
  readonly body: readonly Node[];
  readonly span: Span;
}

export const Nodes = Data.taggedEnum<Node>();

export type Body = Data.TaggedEnum<{
  Fragment: { readonly nodes: readonly Node[] };
  Messages: { readonly messages: readonly Message[] };
}>;

export const Bodies = Data.taggedEnum<Body>();

export const PrimitiveTypes = {
  Boolean: "Boolean",
  File: "File",
  Json: "Json",
  Number: "Number",
  String: "String",
} as const;

export type PrimitiveType =
  (typeof PrimitiveTypes)[keyof typeof PrimitiveTypes];

export type LiteralType = string | number | boolean;

export interface Field {
  readonly name: string;
  readonly optional: boolean;
  readonly type: TypeNode;
  readonly span: Span;
}

export type TypeNode = Data.TaggedEnum<{
  Primitive: {
    readonly name: PrimitiveType;
    readonly span: Span;
  };
  Literal: {
    readonly values: readonly [LiteralType, ...LiteralType[]];
    readonly span: Span;
  };
  Array: { readonly element: TypeNode; readonly span: Span };
  NullOr: { readonly type: TypeNode; readonly span: Span };
  Struct: {
    readonly fields: readonly Field[];
    readonly span: Span;
  };
}>;

export type StructType = Data.TaggedEnum.Value<TypeNode, "Struct">;

export const TypeNodes = Data.taggedEnum<TypeNode>();

export type InputSpec = Data.TaggedEnum<{
  Inline: { readonly type: StructType };
  Reference: {
    readonly module: string;
    readonly exportName: string;
    readonly span: Span;
  };
}>;

export interface Frontmatter {
  readonly description?: string;
  readonly input?: InputSpec;
  readonly span: Span;
}

export const InputSpecs = Data.taggedEnum<InputSpec>();

export interface PromptDocument {
  readonly path?: string;
  readonly frontmatter?: Frontmatter;
  readonly body: Body;
}

export const reservedWords: ReadonlySet<string> = new Set([
  "else",
  "false",
  "null",
  "this",
  "true",
]);

export const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;
