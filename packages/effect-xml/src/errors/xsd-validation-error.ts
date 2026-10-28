import { Schema } from "effect";
import { describePosition } from "./xml-position.ts";

export interface XsdIssue {
  readonly column: number;
  readonly line: number;
  readonly message: string;
}

export class XsdValidationError extends Schema.TaggedError<
  XsdValidationError,
  { readonly brand: unique symbol }
>()("XsdValidationError", {
  cause: Schema.optionalKey(Schema.Defect()),
  issues: Schema.Array(
    Schema.Struct({ column: Schema.Number, line: Schema.Number, message: Schema.String }),
  ),
  message: Schema.String,
}) {
  readonly code = "XSD_VALIDATION";

  static fromReason({
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
