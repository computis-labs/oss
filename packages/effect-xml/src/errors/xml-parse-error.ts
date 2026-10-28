import { Schema } from "effect";
import { describePosition } from "./xml-position.ts";
import type { XmlPosition } from "./xml-position.ts";

export class XmlParseError extends Schema.TaggedError<
  XmlParseError,
  { readonly brand: unique symbol }
>()("XmlParseError", {
  message: Schema.String,
  position: Schema.Struct({ column: Schema.Number, line: Schema.Number, offset: Schema.Number }),
}) {
  readonly code = "XML_PARSE";

  static fromReason({
    position,
    reason,
  }: {
    readonly position: XmlPosition;
    readonly reason: string;
  }) {
    return new XmlParseError({ message: `${reason} ${describePosition(position)}`, position });
  }
}
