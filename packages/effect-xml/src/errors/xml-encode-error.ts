import { Data } from "effect";

export class XmlEncodeError extends Data.TaggedError("XmlEncodeError")<{
  readonly cause?: unknown;
  readonly message: string;
  readonly path: string;
}> {
  readonly code = "XML_ENCODE";

  static make({
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
