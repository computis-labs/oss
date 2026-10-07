import { Data } from "effect";
import { describePosition } from "./xml-position.ts";

export interface XsdIssue {
  readonly column: number;
  readonly line: number;
  readonly message: string;
}

export class XsdValidationError extends Data.TaggedError("XsdValidationError")<{
  readonly cause?: unknown;
  readonly issues: readonly XsdIssue[];
  readonly message: string;
}> {
  readonly code = "XSD_VALIDATION";

  static make({
    reason,
    ...fields
  }: {
    readonly cause?: unknown;
    readonly issues: readonly XsdIssue[];
    readonly reason: string;
  }) {
    return new XsdValidationError({
      ...fields,
      message:
        fields.issues.length === 0
          ? reason
          : `${reason}: ${fields.issues
              .map((issue) => `${issue.message} ${describePosition(issue)}`)
              .join("; ")}`,
    });
  }
}
