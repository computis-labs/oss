import { SchemaAST } from "effect";
import type { Schema } from "effect";
import type { ElementOptions, RootOptions } from "./types.ts";

const ROOT_ANNOTATION = "@computis/effect-xml/root";
const ELEMENT_ANNOTATION = "@computis/effect-xml/element";

/* oxlint-disable typescript/no-namespace, no-shadow -- Schema annotations are typed by declaration merging */
declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations {
      readonly "@computis/effect-xml/element"?: ElementOptions | undefined;
      readonly "@computis/effect-xml/root"?: (RootOptions & { readonly name: string }) | undefined;
    }
  }
}
/* oxlint-enable typescript/no-namespace, no-shadow */

type WithAttributes<Key extends string> = Schema.Top & {
  readonly ast: SchemaAST.Objects | SchemaAST.Union;
  readonly Encoded: { readonly [Attribute in Key]?: string };
};

export const root =
  <const Key extends string = never>(
    name: string,
    options?: RootOptions & { readonly attributes?: readonly Key[] },
  ) =>
  <S extends WithAttributes<Key>>(self: S): S["Rebuild"] =>
    self.annotate({ [ROOT_ANNOTATION]: { ...options, name } });

export const element =
  <const Key extends string>(options: ElementOptions & { readonly attributes: readonly Key[] }) =>
  <S extends WithAttributes<Key>>(self: S): S["Rebuild"] =>
    self.annotate({ [ELEMENT_ANNOTATION]: options });

export const getRoot = (ast: SchemaAST.AST) => SchemaAST.resolve(ast)?.[ROOT_ANNOTATION];

export const getElement = (ast: SchemaAST.AST) => SchemaAST.resolve(ast)?.[ELEMENT_ANNOTATION];
