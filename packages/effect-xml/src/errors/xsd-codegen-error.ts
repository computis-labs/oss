import { Data } from "effect";

export class XsdCodegenError extends Data.TaggedError("XsdCodegenError")<{
  readonly cause?: unknown;
  readonly message: string;
  readonly path: string;
}> {
  readonly code = "XSD_CODEGEN";
}
