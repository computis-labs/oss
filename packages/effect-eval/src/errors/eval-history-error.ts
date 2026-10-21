import { Data } from "effect";

export class EvalHistoryError extends Data.TaggedError("EvalHistoryError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {
  readonly code = "EVAL_HISTORY";
}
