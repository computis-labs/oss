import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { decodePayload } from "../src/action-context.ts";
import { ActionContextErrorReason } from "../src/errors/action-context-error.ts";
import * as ActionContextTest from "../src/testing/action-context-test.ts";

const PullRequestEvent = Schema.Struct({
  pull_request: Schema.Struct({ number: Schema.Number }),
});

describe("decodePayload", () => {
  it.effect("decodes the event payload into its schema", () =>
    Effect.gen(function* () {
      const event = yield* decodePayload(PullRequestEvent);

      expect(event.pull_request.number).toBe(42);
    }).pipe(
      Effect.provide(
        ActionContextTest.make({
          eventName: "pull_request",
          payload: { action: "opened", pull_request: { draft: false, number: 42 } },
        }),
      ),
    ),
  );

  it.effect("names the event when the payload does not match", () =>
    Effect.gen(function* () {
      const error = yield* decodePayload(PullRequestEvent).pipe(Effect.flip);

      expect(error.reason).toBe(ActionContextErrorReason.InvalidPayload);
      expect(error.message).toMatch(/^The issue_comment payload does not match: /u);
    }).pipe(
      Effect.provide(
        ActionContextTest.make({ eventName: "issue_comment", payload: { issue: { number: 42 } } }),
      ),
    ),
  );
});
