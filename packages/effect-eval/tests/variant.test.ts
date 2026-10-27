import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer, pipe } from "effect";
import * as Variant from "../src/variant.ts";

const Model = Context.Reference<string>("tests/Model", { defaultValue: () => "none" });
const Prompt = Context.Reference<string>("tests/Prompt", { defaultValue: () => "none" });

const models = [
  Variant.make("haiku", Layer.succeed(Model, "haiku")),
  Variant.make("sonnet", Layer.succeed(Model, "sonnet")),
];

const prompts = [
  Variant.make("v1", Layer.succeed(Prompt, "v1")),
  Variant.make("v2", Layer.succeed(Prompt, "v2")),
];

const settingsUnder = (variant: Variant.Variant<never>) =>
  Effect.all([Effect.service(Model), Effect.service(Prompt)]).pipe(Effect.provide(variant.layer));

describe("Variant.matrix", () => {
  it("names every combination of the axes in order", () => {
    expect(
      Variant.matrix({ model: models, prompt: prompts }).map((variant) => variant.name),
    ).toEqual([
      "model=haiku · prompt=v1",
      "model=haiku · prompt=v2",
      "model=sonnet · prompt=v1",
      "model=sonnet · prompt=v2",
    ]);
  });

  it.effect("merges the layers of the combination", () =>
    Effect.gen(function* () {
      const variants = Variant.matrix({ model: models, prompt: prompts });

      const settings = yield* pipe(variants, Effect.forEach(settingsUnder));

      expect(settings).toEqual([
        ["haiku", "v1"],
        ["haiku", "v2"],
        ["sonnet", "v1"],
        ["sonnet", "v2"],
      ]);
    }),
  );

  it("has no variant when an axis is empty", () => {
    expect(Variant.matrix({ model: models, prompt: [] })).toEqual([]);
  });

  it("has no variant without axes", () => {
    expect(Variant.matrix({})).toEqual([]);
  });
});

describe("Variant.none", () => {
  it.effect("is the default variant and changes nothing", () =>
    Effect.gen(function* () {
      expect(Variant.none.name).toBe("default");
      expect(yield* settingsUnder(Variant.none)).toEqual(["none", "none"]);
    }),
  );
});

const ModelName = Context.Service<{ readonly model: string }>("tests/ModelName");
const PromptText = Context.Service<{ readonly prompt: string }>("tests/PromptText");
const Settings = Context.Service<{ readonly temperature: number }>("tests/Settings");

describe("Variant.matrix with services that have no default", () => {
  it.effect("combines the services every axis provides", () =>
    Effect.gen(function* () {
      const variants = Variant.matrix({
        model: [Variant.make("m", Layer.succeed(ModelName, { model: "m" }))],
        prompt: [Variant.make("p", Layer.succeed(PromptText, { prompt: "p" }))],
      });

      const both = Effect.all([Effect.service(ModelName), Effect.service(PromptText)]).pipe(
        Effect.map(([settings, text]) => [settings.model, text.prompt]),
      );

      const settings = yield* pipe(
        variants,
        Effect.forEach((variant) => both.pipe(Effect.provide(variant.layer))),
      );

      expect(settings).toEqual([["m", "p"]]);
    }),
  );

  it.effect("promises only the services every alternative of an axis provides", () =>
    Effect.gen(function* () {
      const variants = Variant.matrix({
        impl: [
          Variant.make("a", Layer.succeed(ModelName, { model: "a" })),
          Variant.make("b", Layer.succeed(PromptText, { prompt: "b" })),
        ],
        model: [Variant.make("m", Layer.succeed(Settings, { temperature: 0 }))],
      });

      const temperatures = yield* pipe(
        variants,
        Effect.forEach((variant) => {
          // @ts-expect-error ModelName comes only from the alternative "a" of the axis impl
          const unsound: Effect.Effect<unknown> = Effect.service(ModelName).pipe(
            Effect.provide(variant.layer),
          );

          return Effect.service(Settings).pipe(
            Effect.map((settings) => [unsound === undefined, settings.temperature]),
            Effect.provide(variant.layer),
          );
        }),
      );

      expect(temperatures).toEqual([
        [false, 0],
        [false, 0],
      ]);
    }),
  );
});
