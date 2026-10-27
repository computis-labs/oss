import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import * as ActionClient from "../src/action-client.ts";
import * as ActionContext from "../src/action-context.ts";
import * as ActionRunner from "../src/action-runner.ts";
import * as ActionClientTest from "../src/testing/action-client-test.ts";
import * as ActionContextTest from "../src/testing/action-context-test.ts";
import * as ActionRunnerTest from "../src/testing/action-runner-test.ts";

describe("module accessors", () => {
  it.effect("read and write through the provided services, as upstream code does", () => {
    const runner = ActionRunnerTest.make({ inputs: { "pr-number": "42" } });

    return Effect.gen(function* () {
      const prNumber = yield* ActionRunner.getInput("pr-number", { required: true });
      const { repo } = yield* ActionContext.repo;

      const comment = yield* ActionClient.requestDecoded(
        Schema.Struct({ id: Schema.Number }),
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        { body: "hello", issue_number: Number(prNumber), owner: "computis-labs", repo },
      );

      yield* ActionRunner.setOutput("comment-id", comment.id);

      expect(runner.recording.outputs.get("comment-id")).toBe(7);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          runner.layer,
          ActionContextTest.make({ repo: { owner: "computis-labs", repo: "computis" } }),
          ActionClientTest.make({
            fetch: async (input) =>
              new URL(input instanceof Request ? input.url : input).pathname ===
              "/repos/computis-labs/computis/issues/42/comments"
                ? await Promise.resolve(Response.json({ id: 7 }, { status: 201 }))
                : await Promise.resolve(Response.json({ message: "Not Found" }, { status: 404 })),
          }),
        ),
      ),
    );
  });
});
