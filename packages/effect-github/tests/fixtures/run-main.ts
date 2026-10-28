import { Effect, Schema } from "effect";
import { runMain } from "../../src/action.ts";
import { ActionFailed } from "../../src/errors/action-failed.ts";

class MergeConflict extends Schema.TaggedError<MergeConflict>()("MergeConflict", {
  path: Schema.String,
}) {
  readonly code = "MERGE_CONFLICT";

  override get message() {
    return `pnpm-lock.yaml conflicts in ${this.path}`;
  }
}

const draftFailure = Effect.fail(new ActionFailed({ message: "Draft pull requests cannot merge" }));

const succeed = () => {
  runMain(Effect.void, { disablePrettyLogger: true });
};

const scenarios = new Map([
  [
    "action-failed",
    () => {
      runMain(draftFailure, { disablePrettyLogger: true });
    },
  ],
  [
    "domain-error",
    () => {
      runMain(Effect.fail(new MergeConflict({ path: "apps/web" })), { disablePrettyLogger: true });
    },
  ],
  [
    "pretty-failure",
    () => {
      runMain(draftFailure);
    },
  ],
  ["succeed", succeed],
  [
    "unreported-failure",
    () => {
      runMain(draftFailure, { disableErrorReporting: true, disablePrettyLogger: true });
    },
  ],
]);

const run = scenarios.get(process.argv[2] ?? "succeed") ?? succeed;

run();
