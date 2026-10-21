import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Layer, Option, Ref, Schema, Stream } from "effect";
import { AiError, LanguageModel } from "effect/ai";
import type { Response } from "effect/ai";
import { withLive } from "../src/clock.ts";
import * as Usage from "../src/usage.ts";

const fakeModel = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: () =>
      Effect.succeed([
        { text: "rent", type: "text" },
        {
          reason: "stop",
          type: "finish",
          usage: { inputTokens: { total: 120 }, outputTokens: { reasoning: 4, total: 9 } },
        },
      ]),
    streamText: () => Stream.empty,
  }),
);

const metered = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const recorded = yield* Ref.make<readonly Usage.Usage[]>([]);
    yield* self.pipe(
      Effect.provideService(Usage.Meter, {
        record: (usage) => Ref.update(recorded, (all) => [...all, usage]),
      }),
    );
    return yield* Ref.get(recorded);
  });

describe("Usage.record", () => {
  it.effect("reports one call with the tokens and cost given", () =>
    Effect.gen(function* () {
      const recorded = yield* metered(Usage.record({ costUsd: 0.01, inputTokens: 300 }));

      expect(recorded).toEqual([
        {
          calls: 1,
          costUsd: Option.some(0.01),
          inputTokens: 300,
          labels: {},
          outputTokens: 0,
          reasoningTokens: 0,
        },
      ]);
    }),
  );

  it.effect("files the usage under its label as well as in the total", () =>
    Effect.gen(function* () {
      const recorded = yield* metered(
        Effect.all([
          Usage.record({ inputTokens: 300, label: "judge:faithful" }),
          Usage.record({ inputTokens: 100, label: "judge:faithful" }),
          Usage.record({ inputTokens: 50 }),
        ]),
      );

      expect(Usage.total(recorded)).toMatchObject({
        calls: 3,
        inputTokens: 450,
        labels: { "judge:faithful": { calls: 2, inputTokens: 400 } },
      });
    }),
  );

  it.effect("does nothing outside a run", () =>
    Effect.gen(function* () {
      yield* Usage.record({ inputTokens: 300 });
    }),
  );
});

describe("Usage.total", () => {
  it("adds every count, and the cost when every call has one", () => {
    expect(
      Usage.total([
        Usage.fromRecorded({ costUsd: 0.25, inputTokens: 10, outputTokens: 2 }),
        Usage.fromRecorded({ calls: 2, costUsd: 0.5, inputTokens: 5, reasoningTokens: 7 }),
        Usage.empty,
      ]),
    ).toEqual({
      calls: 3,
      costUsd: Option.some(0.75),
      inputTokens: 15,
      labels: {},
      outputTokens: 2,
      reasoningTokens: 7,
    });
  });

  it("does not know the cost when one call has no price, in either order", () => {
    const priced = Usage.fromRecorded({ costUsd: 0.25 });
    const unpriced = Usage.fromRecorded({ inputTokens: 100, label: "judge:valid" });

    expect([
      Usage.total([priced, unpriced]).costUsd,
      Usage.total([unpriced, priced]).costUsd,
    ]).toEqual([Option.none(), Option.none()]);
  });

  it("does not know the cost of a label when one of its calls has no price", () => {
    const total = Usage.total([
      Usage.fromRecorded({ costUsd: 0.25, label: "judge:valid" }),
      Usage.fromRecorded({ label: "judge:valid" }),
    ]);

    expect(total.labels["judge:valid"]?.costUsd).toEqual(Option.none());
  });

  it("has no cost when no usage has one", () => {
    expect(Usage.total([Usage.fromRecorded({}), Usage.empty]).costUsd).toEqual(Option.none());
  });
});

describe("Usage.trackLanguageModel", () => {
  it.effect("records the usage of every generateText call", () =>
    Effect.gen(function* () {
      const recorded = yield* metered(
        Effect.gen(function* () {
          const first = yield* LanguageModel.generateText({ prompt: "Categorize: AFFITTO" });
          yield* LanguageModel.generateText({ prompt: "Categorize: ENI" });
          expect(first.text).toBe("rent");
        }).pipe(Effect.provide(Usage.trackLanguageModel.pipe(Layer.provide(fakeModel)))),
      );

      expect(Usage.total(recorded)).toEqual({
        calls: 2,
        costUsd: Option.none(),
        inputTokens: 240,
        labels: {},
        outputTokens: 18,
        reasoningTokens: 8,
      });
    }),
  );

  it.effect("records nothing for a model that is not tracked", () =>
    Effect.gen(function* () {
      const recorded = yield* metered(
        LanguageModel.generateText({ prompt: "Categorize: AFFITTO" }).pipe(
          Effect.provide(fakeModel),
        ),
      );

      expect(recorded).toEqual([]);
    }),
  );
});

const failingModel = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: () =>
      Effect.fail(
        AiError.make({
          method: "generateText",
          module: "Fake",
          reason: new AiError.UnknownError({ description: "provider down" }),
        }),
      ),
    streamText: () => Stream.empty,
  }),
);

const malformedModel = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: () =>
      Effect.succeed([
        { text: '{"ok":"maybe"}', type: "text" },
        {
          reason: "stop",
          type: "finish",
          usage: { inputTokens: { total: 50 }, outputTokens: { total: 10 } },
        },
      ]),
    streamText: () => Stream.empty,
  }),
);

const hangingModel = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: () => Effect.never,
    streamText: () => Stream.empty,
  }),
);

describe("Usage.trackLanguageModel on failures", () => {
  it.effect("counts a request cut by a timeout as one call with an unknown cost", () =>
    Effect.gen(function* () {
      const recorded = yield* metered(
        LanguageModel.generateText({ prompt: "Categorize: AFFITTO" }).pipe(
          Effect.provide(Usage.trackLanguageModel.pipe(Layer.provide(hangingModel))),
          Effect.timeout(Duration.millis(5)),
          Effect.ignore,
        ),
      ).pipe(withLive);

      expect(Usage.total(recorded)).toMatchObject({ calls: 1, costUsd: Option.none() });
    }),
  );

  it.effect("counts a request the provider fails as one call", () =>
    Effect.gen(function* () {
      const recorded = yield* metered(
        LanguageModel.generateText({ prompt: "Categorize: AFFITTO" }).pipe(
          Effect.provide(Usage.trackLanguageModel.pipe(Layer.provide(failingModel))),
          Effect.ignore,
        ),
      );

      expect(Usage.total(recorded)).toMatchObject({ calls: 1, inputTokens: 0 });
    }),
  );

  it.effect("keeps the tokens of an answer that does not match the schema", () =>
    Effect.gen(function* () {
      const recorded = yield* metered(
        LanguageModel.generateObject({
          prompt: "Is it ok?",
          schema: Schema.Struct({ ok: Schema.Boolean }),
        }).pipe(
          Effect.provide(Usage.trackLanguageModel.pipe(Layer.provide(malformedModel))),
          Effect.ignore,
        ),
      );

      expect(Usage.total(recorded)).toMatchObject({
        calls: 1,
        inputTokens: 50,
        outputTokens: 10,
      });
    }),
  );
});

const streamFinish = {
  reason: "stop",
  type: "finish",
  usage: { inputTokens: { total: 120 }, outputTokens: { reasoning: 4, total: 9 } },
} as const;

const streamed = (parts: Stream.Stream<Response.StreamPartEncoded, AiError.AiError>) =>
  Stream.runDrain(LanguageModel.streamText({ prompt: "Categorize: AFFITTO" })).pipe(
    Effect.provide(
      Usage.trackLanguageModel.pipe(
        Layer.provide(
          Layer.effect(
            LanguageModel.LanguageModel,
            LanguageModel.make({ generateText: () => Effect.never, streamText: () => parts }),
          ),
        ),
      ),
    ),
  );

describe("Usage.trackLanguageModel on streams", () => {
  it.effect("records one call with the tokens of the finish part when the stream ends", () =>
    Effect.gen(function* () {
      const recorded = yield* metered(
        streamed(
          Stream.make({ delta: "rent", id: "t", type: "text-delta" } as const, streamFinish),
        ),
      );

      expect(recorded).toEqual([
        Usage.fromRecorded({ inputTokens: 120, outputTokens: 9, reasoningTokens: 4 }),
      ]);
    }),
  );

  it.effect("records one call with an unknown cost when the stream fails", () =>
    Effect.gen(function* () {
      const recorded = yield* metered(
        streamed(
          Stream.fail(
            AiError.make({
              method: "streamText",
              module: "Fake",
              reason: new AiError.UnknownError({ description: "provider down" }),
            }),
          ),
        ).pipe(Effect.ignore),
      );

      expect(recorded).toEqual([Usage.fromRecorded({})]);
    }),
  );

  it.effect("records one call when the stream is interrupted", () =>
    Effect.gen(function* () {
      const recorded = yield* metered(
        streamed(Stream.never).pipe(Effect.timeout(Duration.millis(5)), Effect.ignore),
      ).pipe(withLive);

      expect(Usage.total(recorded)).toMatchObject({ calls: 1, costUsd: Option.none() });
    }),
  );
});

describe("Usage.track", () => {
  it.effect("records the usage of one response", () =>
    Effect.gen(function* () {
      const recorded = yield* metered(
        LanguageModel.generateText({ prompt: "Categorize: AFFITTO" }).pipe(
          Usage.track,
          Effect.provide(fakeModel),
        ),
      );

      expect(recorded.map((usage) => usage.inputTokens)).toEqual([120]);
    }),
  );
});
