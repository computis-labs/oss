import { Schema } from "effect";
import { describePosition } from "./xml-position.ts";
import type { XmlPosition } from "./xml-position.ts";

export class XmlDecodeError extends Schema.TaggedError<
  XmlDecodeError,
  { readonly brand: unique symbol }
>()("XmlDecodeError", {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
  path: Schema.String,
  position: Schema.optional(
    Schema.Struct({ column: Schema.Number, line: Schema.Number, offset: Schema.Number }),
  ),
}) {
  readonly code = "XML_DECODE";

  static fromReason({
    reason,
    ...fields
  }: {
    readonly cause?: unknown;
    readonly path: string;
    readonly position?: XmlPosition | undefined;
    readonly reason: string;
  }) {
    const at = `${reason} at ${fields.path}`;

    return new XmlDecodeError({
      ...fields,
      message: fields.position === undefined ? at : `${at} ${describePosition(fields.position)}`,
    });
  }
}
