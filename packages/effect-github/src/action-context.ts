import { context } from "@actions/github";
import { thrownMessage } from "./thrown-message.ts";
import { Context, Effect, Layer, Schema } from "effect";
import { ActionContextError, ActionContextErrorReason } from "./errors/action-context-error.ts";

export interface RepoContext {
  readonly owner: string;
  readonly repo: string;
}

export interface IssueContext extends RepoContext {
  readonly number: number;
}

export interface ActionContextApi {
  readonly eventName: string;
  readonly payload: unknown;
  readonly workflow: string;
  readonly action: string;
  readonly actor: string;
  readonly job: string;
  readonly runId: number;
  readonly runNumber: number;
  readonly runAttempt: number;
  readonly ref: string;
  readonly sha: string;
  readonly apiUrl: string;
  readonly serverUrl: string;
  readonly graphqlUrl: string;
  readonly repo: Effect.Effect<RepoContext, ActionContextError>;
  readonly issue: Effect.Effect<IssueContext, ActionContextError>;
}

const readRepository = Effect.fn("ActionContext.readRepository")(function* readRepository<A>(
  read: () => A,
) {
  return yield* Effect.try({
    catch: (cause) =>
      new ActionContextError({
        cause,
        description: thrownMessage(cause, "GITHUB_REPOSITORY is not set"),
        reason: ActionContextErrorReason.InvalidRepo,
      }),
    try: read,
  });
});

export class ActionContext extends Context.Service<ActionContext, ActionContextApi>()(
  "@computis/effect-github/ActionContext",
) {
  static readonly layer = Layer.sync(ActionContext, () => ({
    action: context.action,
    actor: context.actor,
    apiUrl: context.apiUrl,
    eventName: context.eventName,
    graphqlUrl: context.graphqlUrl,
    issue: readRepository(() => context.issue),
    job: context.job,
    payload: context.payload,
    ref: context.ref,
    repo: readRepository(() => context.repo),
    runAttempt: context.runAttempt,
    runId: context.runId,
    runNumber: context.runNumber,
    serverUrl: context.serverUrl,
    sha: context.sha,
    workflow: context.workflow,
  }));
}

export const decodePayload = Effect.fn("ActionContext.decodePayload")(function* decodePayload<
  S extends Schema.Top,
>(schema: S) {
  const current = yield* ActionContext;
  return yield* Schema.decodeUnknownEffect(schema)(current.payload).pipe(
    Effect.mapError(
      (cause) =>
        new ActionContextError({
          cause,
          description: `The ${current.eventName} payload does not match: ${cause.message}`,
          reason: ActionContextErrorReason.InvalidPayload,
        }),
    ),
  );
});

const actionContext = Effect.service(ActionContext);

export const eventName = actionContext.pipe(Effect.map((current) => current.eventName));

export const payload = actionContext.pipe(Effect.map((current) => current.payload));

export const workflow = actionContext.pipe(Effect.map((current) => current.workflow));

export const action = actionContext.pipe(Effect.map((current) => current.action));

export const actor = actionContext.pipe(Effect.map((current) => current.actor));

export const job = actionContext.pipe(Effect.map((current) => current.job));

export const runId = actionContext.pipe(Effect.map((current) => current.runId));

export const runNumber = actionContext.pipe(Effect.map((current) => current.runNumber));

export const runAttempt = actionContext.pipe(Effect.map((current) => current.runAttempt));

export const ref = actionContext.pipe(Effect.map((current) => current.ref));

export const sha = actionContext.pipe(Effect.map((current) => current.sha));

export const apiUrl = actionContext.pipe(Effect.map((current) => current.apiUrl));

export const serverUrl = actionContext.pipe(Effect.map((current) => current.serverUrl));

export const graphqlUrl = actionContext.pipe(Effect.map((current) => current.graphqlUrl));

export const repo = actionContext.pipe(Effect.flatMap((current) => current.repo));

export const issue = actionContext.pipe(Effect.flatMap((current) => current.issue));

export const { layer } = ActionContext;
