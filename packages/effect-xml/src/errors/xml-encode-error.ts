import { Schema } from "effect";

export class XmlEncodeError extends Schema.TaggedError<
  XmlEncodeError,
  { readonly brand: unique symbol }
>()("XmlEncodeError", {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
  path: Schema.String,
}) {
  readonly code = "XML_ENCODE";

  static fromReason({
    reason,
    ...fields
  }: {
    readonly cause?: unknown;
    readonly path: string;
    readonly reason: string;
  }) {
    return new XmlEncodeError({ ...fields, message: `${reason} at ${fields.path}` });
  }
}
