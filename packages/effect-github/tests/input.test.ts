import { describe, expect, it } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { InputValidationFailure } from "../src/errors/input-validation-failure.ts";
import * as Input from "../src/input.ts";
import * as ActionRunnerTest from "../src/testing/action-runner-test.ts";

const inputs = (values: Record<string, string>) => ActionRunnerTest.make({ inputs: values }).layer;

describe("Input", () => {
  it.effect("parses an integer input after trimming it", () =>
    Effect.gen(function* () {
      const retries = yield* Input.integer("retries").pipe(
        Effect.provide(inputs({ retries: " 3 " })),
      );

      expect(retries).toBe(3);
    }),
  );

  it.effect("rejects a fractional integer input and names the input", () =>
    Effect.gen(function* () {
      const failure = yield* Input.integer("retries").pipe(
        Effect.provide(inputs({ retries: "2.5" })),
        Effect.flip,
      );

      expect(failure).toBeInstanceOf(InputValidationFailure);
      expect(failure.input).toBe("retries");
      expect(failure.value).toBe("2.5");
    }),
  );

  it.effect("fails a required input that was not supplied", () =>
    Effect.gen(function* () {
      const failure = yield* Input.nonEmptyString("token").pipe(
        Effect.provide(inputs({})),
        Effect.flip,
      );

      expect(failure.displayMessage).toMatch(/^Input 'token' is invalid: /u);
    }),
  );

  it.effect.each([
    ["TRUE", true],
    ["False", false],
    ["yes", true],
    ["Off", false],
    ["1", true],
    ["", false],
  ] as const)("reads the boolean input %j as %s", ([raw, expected]) =>
    Effect.gen(function* () {
      const force = yield* Input.boolean("force").pipe(Effect.provide(inputs({ force: raw })));

      expect(force).toBe(expected);
    }),
  );

  it.effect("rejects a boolean input outside the YAML booleans", () =>
    Effect.gen(function* () {
      const failure = yield* Input.boolean("force").pipe(
        Effect.provide(inputs({ force: "maybe" })),
        Effect.flip,
      );

      expect(failure.value).toBe("maybe");
    }),
  );

  it.effect("decodes a JSON input against its schema", () =>
    Effect.gen(function* () {
      const labels = yield* Input.json("labels", Schema.Array(Schema.String)).pipe(
        Effect.provide(inputs({ labels: '["announce","bug"]' })),
      );

      expect(labels).toStrictEqual(["announce", "bug"]);
    }),
  );

  it.effect("keeps a secret input redacted", () =>
    Effect.gen(function* () {
      const token = yield* Input.secret("token").pipe(
        Effect.provide(inputs({ token: "ghs_s3cr3t" })),
      );

      expect(Redacted.value(token)).toBe("ghs_s3cr3t");
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ token }),
      ).not.toContain("ghs_s3cr3t");
    }),
  );
});
