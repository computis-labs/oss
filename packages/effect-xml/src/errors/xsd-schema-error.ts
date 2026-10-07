import { Data } from "effect";

export class XsdSchemaError extends Data.TaggedError("XsdSchemaError")<{
  readonly cause?: unknown;
  readonly message: string;
}> {
  readonly code = "XSD_SCHEMA";
}
