import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { ActionApiError } from "../src/errors/action-api-error.ts";
import {
  ActionContextError,
  ActionContextErrorReason,
} from "../src/errors/action-context-error.ts";
import { ActionFailed } from "../src/errors/action-failed.ts";
import { isActionError, isActionFailure } from "../src/errors/action-failure.ts";
import type { ActionError } from "../src/errors/action-failure.ts";
import { ActionInputError, ActionInputErrorReason } from "../src/errors/action-input-error.ts";
import { ActionOIDCError, ActionOIDCErrorReason } from "../src/errors/action-oidc-error.ts";
import {
  ActionSummaryError,
  ActionSummaryErrorReason,
} from "../src/errors/action-summary-error.ts";
import {
  InputValidationFailure,
  InputValidationFailureReason,
} from "../src/errors/input-validation-failure.ts";

class MergeConflict extends Schema.TaggedError<MergeConflict>()("MergeConflict", {
  path: Schema.String,
}) {}

const packageErrors: readonly ActionError[] = [
  new ActionInputError({ name: "token", reason: ActionInputErrorReason.Missing }),
  new ActionContextError({ reason: ActionContextErrorReason.InvalidRepo }),
  new ActionApiError({ method: "GET /user", status: 404 }),
  new ActionOIDCError({ reason: ActionOIDCErrorReason.NotAvailable }),
  new ActionSummaryError({ reason: ActionSummaryErrorReason.WriteFailed }),
  new InputValidationFailure({
    input: "retries",
    message: "Expected an integer",
    reason: InputValidationFailureReason.SchemaValidation,
    value: "2.5",
  }),
  new ActionFailed({ message: "Draft pull requests cannot merge" }),
];

describe("isActionError", () => {
  it.each(packageErrors)("recognises the package error $_tag", (packageError) => {
    expect(isActionError(packageError)).toBe(true);
  });

  it("rejects an error of the caller", () => {
    expect(isActionError(new MergeConflict({ path: "apps/web" }))).toBe(false);
  });
});

describe("isActionFailure", () => {
  it("leaves out an error that is not a step failure", () => {
    expect(isActionFailure(new ActionApiError({ method: "GET /user", status: 404 }))).toBe(false);
  });
});
