import { Data } from "effect";

export class EvalConfigError extends Data.TaggedError("EvalConfigError")<{
  readonly path: string;
  readonly message: string;
  readonly cause?: unknown;
}> {
  readonly code = "EVAL_CONFIG";
}
