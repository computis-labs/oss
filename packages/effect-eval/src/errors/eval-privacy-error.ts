import { Data } from "effect";
import type { Finding } from "../privacy.ts";

export class EvalPrivacyError extends Data.TaggedError("EvalPrivacyError")<{
  readonly findings: readonly Finding[];
}> {
  readonly code = "EVAL_PRIVACY";

  override get message() {
    return this.findings
      .map((finding) => `${finding.case} ${finding.path}: ${finding.rule}`)
      .join("\n");
  }
}
