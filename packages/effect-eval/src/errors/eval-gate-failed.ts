import { Option, Schema } from "effect";
import { GateResultSchema } from "../events.ts";

export class EvalGateFailed extends Schema.TaggedError<
  EvalGateFailed,
  { readonly brand: unique symbol }
>()("EvalGateFailed", {
  results: Schema.Array(GateResultSchema),
}) {
  readonly code = "EVAL_GATE_FAILED";

  override get message() {
    return this.results
      .map(
        (result) =>
          `${result.variant}: ${result.gate}, got ${result.actual}${result.violations
            .map(
              (scored) =>
                `\n  ${scored.case} ${scored.observation.key}: expected ${scored.observation.detail.expected}, got ${Option.getOrElse(scored.observation.failure, () => scored.observation.detail.actual)}`,
            )
            .join("")}`,
      )
      .join("\n");
  }
}
