import { Schema } from "effect";

export class XsdCodegenError extends Schema.TaggedError<
  XsdCodegenError,
  { readonly brand: unique symbol }
>()("XsdCodegenError", {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
  path: Schema.String,
}) {
  readonly code = "XSD_CODEGEN";
}
