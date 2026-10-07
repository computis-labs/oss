import { Data } from "effect";
import { describePosition } from "./xml-position.ts";
import type { XmlPosition } from "./xml-position.ts";

export class XmlParseError extends Data.TaggedError("XmlParseError")<{
  readonly message: string;
  readonly position: XmlPosition;
}> {
  readonly code = "XML_PARSE";

  static make({ position, reason }: { readonly position: XmlPosition; readonly reason: string }) {
    return new XmlParseError({ message: `${reason} ${describePosition(position)}`, position });
  }
}
