import { Schema } from "effect";

export class EvalBudgetExceeded extends Schema.TaggedError<
  EvalBudgetExceeded,
  { readonly brand: unique symbol }
>()("EvalBudgetExceeded", {
  limit: Schema.Number,
  planned: Schema.Number,
}) {
  readonly code = "EVAL_BUDGET_EXCEEDED";

  override get message() {
    return `The run plans ${String(this.planned)} task calls, more than ${String(this.limit)}: confirm it to go on.`;
  }
}
