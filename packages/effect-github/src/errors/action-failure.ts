import { ActionApiError } from "./action-api-error.ts";
import { ActionContextError } from "./action-context-error.ts";
import { ActionFailed } from "./action-failed.ts";
import { ActionInputError } from "./action-input-error.ts";
import { ActionOIDCError } from "./action-oidc-error.ts";
import { ActionSummaryError } from "./action-summary-error.ts";
import { InputValidationFailure } from "./input-validation-failure.ts";

export type ActionFailure = InputValidationFailure | ActionFailed;

type NarrowedMember<Member, Target> = Member extends Target
  ? Member
  : [Extract<Target, Member>] extends [never]
    ? Member & Target
    : Extract<Target, Member>;

export type Narrowed<E, Target> = E extends unknown ? NarrowedMember<E, Target> : never;

export const isActionFailure = <E>(error: E): error is Narrowed<E, ActionFailure> =>
  error instanceof InputValidationFailure || error instanceof ActionFailed;

export type ActionError =
  | ActionInputError
  | ActionContextError
  | ActionApiError
  | ActionOIDCError
  | ActionSummaryError
  | ActionFailure;

export const isActionError = <E>(error: E): error is Narrowed<E, ActionError> =>
  isActionFailure(error) ||
  error instanceof ActionInputError ||
  error instanceof ActionContextError ||
  error instanceof ActionApiError ||
  error instanceof ActionOIDCError ||
  error instanceof ActionSummaryError;
