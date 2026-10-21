import { Data } from "effect";

export class EvalDatasetError extends Data.TaggedError("EvalDatasetError")<{
  readonly message: string;
  readonly path: string;
  readonly cause?: unknown;
}> {
  readonly code = "EVAL_DATASET";
}
