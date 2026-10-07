import type { Result } from "effect";
import type { XmlParseError } from "./errors/xml-parse-error.ts";

export interface TokenHandler {
  readonly attribute: (qname: string, value: string, offset: number) => boolean;
  readonly close: () => boolean;
  readonly keepWhitespace?: () => boolean;
  readonly openEnd: () => boolean;
  readonly openStart: (qname: string, offset: number) => boolean;
  readonly text: (value: string, offset: number) => boolean;
}

export interface TokenizeOptions {
  readonly maxDepth: number;
}

export type Tokenize = (
  xml: string,
  handler: TokenHandler,
  options?: Partial<TokenizeOptions>,
) => Result.Result<boolean, XmlParseError>;

export interface LeafPlan {
  readonly kind: "leaf";
}

export interface AttributePlan {
  readonly name: string;
}

export type ChildArity = "many" | "one" | "optional";

export interface ChildPlan {
  readonly arity: ChildArity;
  readonly closeTag: string;
  readonly index: number;
  readonly name: string;
  readonly node: ElementPlan | LeafPlan;
  readonly openTag: string;
  readonly optional: boolean;
}

export interface ElementPlan {
  readonly kind: "element";
  readonly attributes: ReadonlyMap<string, AttributePlan>;
  readonly children: ReadonlyMap<string, ChildPlan>;
  readonly sequence: readonly ChildPlan[];
}

export interface RootPlan {
  readonly closeTag: string;
  readonly name: string;
  readonly namespace: string | undefined;
  readonly node: ElementPlan;
  readonly openTagStart: string;
}

export interface RootOptions {
  readonly attributes?: readonly string[];
  readonly namespace?: string;
  readonly prefix?: string;
}

export interface ElementOptions {
  readonly attributes: readonly string[];
}
