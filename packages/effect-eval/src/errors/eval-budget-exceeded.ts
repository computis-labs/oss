import { Data } from "effect";

export class EvalBudgetExceeded extends Data.TaggedError("EvalBudgetExceeded")<{
  readonly planned: number;
  readonly limit: number;
}> {
  readonly code = "EVAL_BUDGET_EXCEEDED";

  override get message() {
    return `The run plans ${String(this.planned)} task calls, more than ${String(this.limit)}: confirm it to go on.`;
  }
}
