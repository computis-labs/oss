import { Data } from "effect";
import { describePosition } from "./xml-position.ts";
import type { XmlPosition } from "./xml-position.ts";

export class XmlDecodeError extends Data.TaggedError("XmlDecodeError")<{
  readonly cause?: unknown;
  readonly message: string;
  readonly path: string;
  readonly position?: XmlPosition | undefined;
}> {
  readonly code = "XML_DECODE";

  static make({
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
