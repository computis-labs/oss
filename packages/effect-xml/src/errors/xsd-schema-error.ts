import { Schema } from "effect";

export class XsdSchemaError extends Schema.TaggedError<
  XsdSchemaError,
  { readonly brand: unique symbol }
>()("XsdSchemaError", {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {
  readonly code = "XSD_SCHEMA";
}
