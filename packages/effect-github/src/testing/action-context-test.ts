import { Effect, Layer } from "effect";
import { ActionContext } from "../action-context.ts";
import type { ActionContextApi, IssueContext, RepoContext } from "../action-context.ts";
import { ActionContextError } from "../errors/action-context-error.ts";

export const make = (
  options: Partial<
    Omit<ActionContextApi, "repo" | "issue"> & {
      readonly repo: RepoContext | ActionContextError;
      readonly issue: IssueContext | ActionContextError;
    }
  > = {},
) => {
  const repo = options.repo ?? { owner: "octocat", repo: "hello-world" };
  const issue = options.issue ?? { number: 1, owner: "octocat", repo: "hello-world" };
  return Layer.succeed(ActionContext, {
    action: options.action ?? "run",
    actor: options.actor ?? "octocat",
    apiUrl: options.apiUrl ?? "https://api.github.com",
    eventName: options.eventName ?? "push",
    graphqlUrl: options.graphqlUrl ?? "https://api.github.com/graphql",
    issue: issue instanceof ActionContextError ? Effect.fail(issue) : Effect.succeed(issue),
    job: options.job ?? "build",
    payload: options.payload ?? {},
    ref: options.ref ?? "refs/heads/main",
    repo: repo instanceof ActionContextError ? Effect.fail(repo) : Effect.succeed(repo),
    runAttempt: options.runAttempt ?? 1,
    runId: options.runId ?? 12_345,
    runNumber: options.runNumber ?? 1,
    serverUrl: options.serverUrl ?? "https://github.com",
    sha: options.sha ?? "abc123def456",
    workflow: options.workflow ?? "CI",
  });
};

export const layer = make();
