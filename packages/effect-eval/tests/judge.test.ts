import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref, Result, Schema, Stream, pipe } from "effect";
import { AiError, LanguageModel } from "effect/ai";
import * as Agreement from "../src/agreement.ts";
import * as Judge from "../src/judge.ts";
import * as Metric from "../src/metric.ts";
import { whenDefined } from "../src/object.ts";
import * as Observation from "../src/observation.ts";
import * as Scorer from "../src/scorer.ts";
import * as Usage from "../src/usage.ts";
import * as Variant from "../src/variant.ts";
import * as Verdict from "../src/verdict.ts";
import { verdicts } from "../src/verdict.ts";

const RubricSchema = Schema.Struct({ faithful: Schema.Boolean, reason: Schema.String });

const answering = (json: string) =>
  Variant.make(
    "fake-judge",
    Layer.effect(
      LanguageModel.LanguageModel,
      LanguageModel.make({
        generateText: () =>
          Effect.succeed([
            { text: json, type: "text" },
            {
              reason: "stop",
              type: "finish",
              usage: { inputTokens: { total: 50 }, outputTokens: { total: 10 } },
            },
          ]),
        streamText: () => Stream.empty,
      }),
    ),
  );

const failing = Variant.make(
  "down",
  Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () =>
        Effect.fail(
          AiError.make({
            method: "generateText",
            module: "fake",
            reason: new AiError.UnknownError({ description: "provider down" }),
          }),
        ),
      streamText: () => Stream.empty,
    }),
  ),
);

const judge = (
  model: Variant.Variant<LanguageModel.LanguageModel>,
  expected?: (input: string) => Scorer.Expectation<string>,
) =>
  Judge.make({
    agreement: (rubric) => (rubric.faithful ? Agreement.exact : Agreement.different),
    ...whenDefined(expected, (given) => ({ expected: given })),
    model,
    name: "faithful",
    note: (rubric) => rubric.reason,
    prompt: (input, output) => `Is "${output}" a faithful summary of "${input.input}"?`,
    rubric: RubricSchema,
    show: (output: string) => output,
  });

const caseOf = (input: string) => ({ id: "s1", input, tags: ["kind:summary"] });

describe("Judge.make", () => {
  it.effect("turns the rubric of the model into an agreement with its note", () =>
    Effect.gen(function* () {
      const [observation] = yield* judge(answering('{"faithful":true,"reason":"same facts"}'))(
        caseOf("Canone di marzo"),
        Result.succeed("March rent"),
      );

      expect(observation).toMatchObject({
        agreement: Option.some(Agreement.exact),
        detail: { actual: "March rent", expected: "judged", note: "same facts" },
        key: "judge:faithful",
        tags: ["kind:summary"],
      });
    }),
  );

  it.effect("records the tokens the judge spends", () =>
    Effect.gen(function* () {
      const recorded = yield* Ref.make(0);

      yield* judge(answering('{"faithful":false,"reason":"wrong month"}'))(
        caseOf("Canone di marzo"),
        Result.succeed("April rent"),
      ).pipe(
        Effect.provideService(Usage.Meter, {
          record: (usage) => Ref.update(recorded, (total) => total + usage.inputTokens),
        }),
      );

      expect(yield* Ref.get(recorded)).toBe(50);
    }),
  );

  it.effect("errors the observation when the model fails or answers outside the rubric", () =>
    Effect.gen(function* () {
      const down = yield* judge(failing)(caseOf("Canone"), Result.succeed("rent"));

      const malformed = yield* judge(answering('{"faithful":"maybe"}'))(
        caseOf("Canone"),
        Result.succeed("rent"),
      );

      expect([...down, ...malformed].map(Verdict.of)).toEqual([verdicts.errored, verdicts.errored]);
      expect(
        Option.exists(down[0]?.failure ?? Option.none(), (failure) =>
          failure.startsWith("judge: "),
        ),
      ).toBe(true);
    }),
  );

  it.effect("does not call the model when the task failed", () =>
    Effect.gen(function* () {
      const observations = yield* judge(failing)(caseOf("Canone"), Result.fail("timeout"));

      expect(observations.map((observation) => observation.failure)).toEqual([
        Option.some("timeout"),
      ]);
    }),
  );

  it.effect("errors a failed task with the expected state the case really has", () =>
    Effect.gen(function* () {
      const observations = yield* pipe(
        [() => Scorer.present("judged"), () => Scorer.absent, () => Scorer.unknown] as const,
        Effect.forEach((expected) =>
          judge(failing, expected)(caseOf("Canone"), Result.fail("provider down")),
        ),
      );

      const judged = observations.flat().map((observation) => ({
        observation,
        verdict: Verdict.of(observation),
      }));

      expect(
        judged.map(({ observation }) => [observation.expected, Verdict.of(observation)]),
      ).toEqual([
        [Observation.expectedStates.present, verdicts.errored],
        [Observation.expectedStates.absent, verdicts.errored],
        [Observation.expectedStates.unknown, verdicts.errored],
      ]);
      expect(Metric.estimate(Metric.recall, judged).n).toBe(1);
    }),
  );

  it.effect("does not call the model when no output is expected or the truth is unknown", () =>
    Effect.gen(function* () {
      const absent = yield* judge(failing, () => Scorer.absent)(
        caseOf("Canone"),
        Result.succeed("rent"),
      );

      const unknown = yield* judge(failing, () => Scorer.unknown)(
        caseOf("Canone"),
        Result.succeed("rent"),
      );

      expect([...absent, ...unknown].map(Verdict.of)).toEqual([verdicts.wrong, verdicts.unscored]);
    }),
  );
});
