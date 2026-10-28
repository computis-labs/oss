import { describe, expectTypeOf, it } from "@effect/vitest";
import { Schema } from "effect";
import type { ActionApiError } from "../src/errors/action-api-error.ts";
import { isActionError, isActionFailure } from "../src/errors/action-failure.ts";
import type { ActionError, ActionFailure } from "../src/errors/action-failure.ts";
import type { InputValidationFailure } from "../src/errors/input-validation-failure.ts";

class MergeConflict extends Schema.TaggedError<MergeConflict>()("MergeConflict", {
  path: Schema.String,
}) {
  readonly code = "MERGE_CONFLICT";
}

describe("the error guards narrow", () => {
  it("an unknown caught value to the package errors", () => {
    expectTypeOf(isActionError<unknown>).guards.toEqualTypeOf<ActionError>();
    expectTypeOf(isActionFailure<unknown>).guards.toEqualTypeOf<ActionFailure>();
  });

  it("an Error to the package errors", () => {
    expectTypeOf(isActionError<Error>).guards.toEqualTypeOf<ActionError>();
    expectTypeOf(isActionFailure<Error>).guards.toEqualTypeOf<ActionFailure>();
  });

  it("a union of caller and package errors to the package member", () => {
    expectTypeOf(
      isActionError<MergeConflict | ActionApiError>,
    ).guards.toEqualTypeOf<ActionApiError>();
  });

  it("a union of Error and one package error to every package error", () => {
    expectTypeOf(isActionError<Error | ActionApiError>).guards.toEqualTypeOf<ActionError>();
    expectTypeOf(
      isActionFailure<Error | InputValidationFailure>,
    ).guards.toEqualTypeOf<ActionFailure>();
  });
});
