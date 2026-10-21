import { Data } from "effect";

export class EvalReporterError extends Data.TaggedError("EvalReporterError")<{
  readonly reporter: string;
  readonly message: string;
  readonly cause?: unknown;
}> {
  readonly code = "EVAL_REPORTER";
}
