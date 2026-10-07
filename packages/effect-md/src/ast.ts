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

export type Expression =
  | {
      readonly _tag: "Path";
      readonly root: string;
      readonly segments: readonly string[];
      readonly span: Span;
    }
  | { readonly _tag: "Data"; readonly name: DataVariable; readonly span: Span }
  | { readonly _tag: "Literal"; readonly value: LiteralValue; readonly span: Span };

export type LiteralExpression = Extract<Expression, { readonly _tag: "Literal" }>;

export type ValueExpression = Exclude<Expression, { readonly _tag: "Literal" }>;

export interface HashArgument {
  readonly name: string;
  readonly value: Expression;
  readonly span: Span;
}

export const ComparisonOperators = {
  equals: "==",
  notEquals: "!=",
} as const;
export type ComparisonOperator = (typeof ComparisonOperators)[keyof typeof ComparisonOperators];

export type Condition =
  | { readonly _tag: "Truthy"; readonly value: ValueExpression; readonly span: Span }
  | {
      readonly _tag: "Compare";
      readonly operator: ComparisonOperator;
      readonly left: ValueExpression;
      readonly right: LiteralExpression;
      readonly span: Span;
    }
  | { readonly _tag: "Not"; readonly condition: Condition; readonly span: Span };

export interface IfBranch {
  readonly condition: Condition;
  readonly body: readonly Node[];
  readonly span: Span;
}

export type Node =
  | { readonly _tag: "Text"; readonly value: string; readonly span: Span }
  | { readonly _tag: "Output"; readonly value: ValueExpression; readonly span: Span }
  | {
      readonly _tag: "Helper";
      readonly name: string;
      readonly args: readonly Expression[];
      readonly hash: readonly HashArgument[];
      readonly span: Span;
    }
  | {
      readonly _tag: "If";
      readonly branches: readonly [IfBranch, ...IfBranch[]];
      readonly alternate: readonly Node[];
      readonly span: Span;
    }
  | {
      readonly _tag: "Each";
      readonly iterable: ValueExpression;
      readonly item: string;
      readonly index?: string;
      readonly body: readonly Node[];
      readonly alternate: readonly Node[];
      readonly span: Span;
    }
  | {
      readonly _tag: "Partial";
      readonly source: string;
      readonly hash: readonly HashArgument[];
      readonly indent: string;
      readonly span: Span;
    };

export interface Message {
  readonly role: Role;
  readonly body: readonly Node[];
  readonly span: Span;
}

export type Body =
  | { readonly _tag: "Fragment"; readonly nodes: readonly Node[] }
  | { readonly _tag: "Messages"; readonly messages: readonly Message[] };

export const PrimitiveTypes = {
  Boolean: "Boolean",
  File: "File",
  Json: "Json",
  Number: "Number",
  String: "String",
} as const;
export type PrimitiveType = (typeof PrimitiveTypes)[keyof typeof PrimitiveTypes];

export type LiteralType = string | number | boolean;

export interface Field {
  readonly name: string;
  readonly optional: boolean;
  readonly type: TypeNode;
  readonly span: Span;
}

export type TypeNode =
  | { readonly _tag: "Primitive"; readonly name: PrimitiveType; readonly span: Span }
  | {
      readonly _tag: "Literal";
      readonly values: readonly [LiteralType, ...LiteralType[]];
      readonly span: Span;
    }
  | { readonly _tag: "Array"; readonly element: TypeNode; readonly span: Span }
  | { readonly _tag: "NullOr"; readonly type: TypeNode; readonly span: Span }
  | { readonly _tag: "Struct"; readonly fields: readonly Field[]; readonly span: Span };

export type StructType = Extract<TypeNode, { readonly _tag: "Struct" }>;

export type InputSpec =
  | { readonly _tag: "Inline"; readonly type: StructType }
  | {
      readonly _tag: "Reference";
      readonly module: string;
      readonly exportName: string;
      readonly span: Span;
    };

export interface Frontmatter {
  readonly description?: string;
  readonly input?: InputSpec;
  readonly span: Span;
}

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
