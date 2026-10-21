import { Data } from "effect";

export class EvalReporterFailed extends Data.TaggedError("EvalReporterFailed")<{
  readonly reporter: string;
  readonly cause: unknown;
}> {
  readonly code = "EVAL_REPORTER_FAILED";

  override get message() {
    return `The required reporter ${this.reporter} failed.`;
  }
}
