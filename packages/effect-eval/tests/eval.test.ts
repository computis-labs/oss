import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Cause, Context, Effect, FileSystem, Layer, Option, Path, Schema, pipe } from "effect";
import * as Dataset from "../src/dataset.ts";
import type { EvalDatasetError } from "../src/errors/eval-dataset-error.ts";
import * as Eval from "../src/eval.ts";
import * as Execution from "../src/execution.ts";
import * as Runner from "../src/runner.ts";
import * as Scorer from "../src/scorer.ts";

const dataset = Dataset.fromIterable(["rent", "fuel"], { id: (label) => label });
const score = Scorer.label<string, string>({ actual: Option.some, expected: Scorer.present });

const cases = [
  { id: "rent", input: "rent", tags: [] },
  { id: "fuel", input: "fuel", tags: [] },
] as const;

class Prefix extends Context.Service<Prefix, { readonly value: string }>()("tests/Prefix") {}

const Scenarios = Context.Service<{ readonly seed: Effect.Effect<string> }>("tests/Scenarios");

const Categories = Context.Service<{
  readonly pick: (scenario: string, description: string) => Effect.Effect<string>;
}>("tests/Categories");

const MovementSchema = Schema.Struct({ description: Schema.String, expected: Schema.String });

type Movement = typeof MovementSchema.Type;

const movements = Dataset.json(MovementSchema, "/movements.json", {
  id: (movement) => movement.description,
});

const scoreMovement = Scorer.label<Movement, string>({
  actual: Option.some,
  expected: (movement) => Scorer.present(movement.expected),
});

const seedMovements = Effect.gen(function* seedMovements() {
  const scenarios = yield* Scenarios;
  const scenario = yield* scenarios.seed;

  if (scenario === "") {
    return yield* new Cause.NoSuchElementError("no scenario");
  }

  return { scenario };
});

const pickCategory = (movement: Movement, seeded: Effect.Success<typeof seedMovements>) =>
  Effect.gen(function* askForCategory() {
    const categories = yield* Categories;
    const category = yield* categories.pick(seeded.scenario, movement.description);

    if (category === "") {
      return yield* new Cause.TimeoutError("the model did not answer");
    }

    return category;
  });

const scriptedServices = Layer.mergeAll(
  FileSystem.layerNoop({
    readFileString: () =>
      Effect.succeed(
        '[{"description":"rent","expected":"rent"},{"description":"fuel","expected":"fuel"}]',
      ),
  }),
  Path.layer,
  Layer.succeed(Scenarios, { seed: Effect.succeed("scenario-1") }),
  Layer.succeed(Categories, { pick: (_scenario, description) => Effect.succeed(description) }),
);

type CategorizerEval = Eval.Eval<
  Movement,
  string,
  Cause.NoSuchElementError | Cause.TimeoutError,
  EvalDatasetError,
  (typeof Scenarios)["Identifier"] | (typeof Categories)["Identifier"],
  FileSystem.FileSystem | Path.Path
>;

describe("Eval.make", () => {
  it("runs once per case, one case at a time, with no gates and no budget by default", () => {
    const categorize = Eval.make({
      dataset,
      name: "categorizer",
      score,
      task: (input) => Effect.succeed(input.input),
    });

    expect(categorize).toMatchObject({
      budget: {},
      gates: [],
      hash: Option.none(),
      output: Option.none(),
      sensitive: false,
      trials: 1,
    });
    expect(Execution.concurrencyOf(categorize.execution)).toBe(1);
  });

  it.effect("prepares a runner that calls the task for every case with the setup value", () =>
    Effect.gen(function* () {
      const categorize = Eval.make({
        dataset,
        name: "categorizer",
        output: Schema.String,
        score,
        setup: Effect.succeed("v2"),
        task: (input, prompt) => Effect.succeed(`${prompt}:${input.input}`),
      });

      const runner = yield* categorize.prepare;

      expect(yield* runner(cases)).toEqual(["v2:rent", "v2:fuel"]);
    }),
  );

  it("refuses a setup value without a setup", () => {
    const withoutSetup = () =>
      Eval.make<string, string, string>(
        // @ts-expect-error a task that reads a setup value needs a setup
        {
          dataset,
          name: "categorizer",
          score,
          task: (input, prompt) => Effect.succeed(`${prompt.toUpperCase()}:${input.input}`),
        },
      );

    const batchedWithoutSetup = () =>
      Eval.makeBatched<string, string, string>(
        // @ts-expect-error a task that reads a setup value needs a setup
        {
          dataset,
          execution: Execution.batched(2),
          name: "categorizer",
          score,
          task: (inputs, prompt) =>
            Effect.succeed(inputs.map((input) => `${prompt.toUpperCase()}:${input.input}`)),
        },
      );

    const inferredWithoutSetup = () =>
      // @ts-expect-error a task that reads a setup value needs a setup
      Eval.make({
        dataset,
        name: "categorizer",
        score,
        task: (_input, setup: { readonly value: string }) => Effect.succeed(setup.value),
      });

    expect([withoutSetup, batchedWithoutSetup, inferredWithoutSetup]).toHaveLength(3);
  });

  it.effect("needs the services of the dataset, the task and the scorer together", () =>
    Effect.gen(function* () {
      const fromFile = Eval.make({
        dataset: Dataset.json(Schema.String, "/labels.json", { id: (label) => label }),
        name: "categorizer",
        score,
        task: (input) =>
          Effect.service(Prefix).pipe(Effect.map((prefix) => `${prefix.value}${input.input}`)),
      });

      const run = yield* Runner.run(fromFile).pipe(
        Effect.provide(
          Layer.mergeAll(
            FileSystem.layerNoop({ readFileString: () => Effect.succeed('["rent","fuel"]') }),
            Path.layer,
            Layer.succeed(Prefix, { value: "" }),
          ),
        ),
      );

      expect(run.variants[0]?.summary.counts["right"]).toBe(2);
    }),
  );
});

describe("Eval.makeBatched", () => {
  it.effect("prepares a runner that hands the whole batch to the task", () =>
    Effect.gen(function* () {
      const categorize = Eval.makeBatched({
        dataset,
        execution: Execution.batched(10),
        name: "categorizer",
        score,
        task: (inputs) => Effect.succeed([inputs.map((input) => input.id).join("+")]),
      });

      const runner = yield* categorize.prepare;

      expect(yield* runner(cases)).toEqual(["rent+fuel"]);
    }),
  );
});

describe("Eval inference", () => {
  it("also accepts the existing explicit error and service parameters for setup", () => {
    const setup = Prefix.use((prefix) =>
      prefix.value === ""
        ? Effect.fail(new Cause.NoSuchElementError())
        : Effect.succeed(prefix.value),
    );

    const single = Eval.make<string, string, string, Cause.NoSuchElementError, never, Prefix>({
      dataset,
      name: "explicit single",
      score,
      setup,
      task: (input, seeded) => Effect.succeed(seeded === "ready" ? input.input : "not ready"),
    });

    const batch = Eval.makeBatched<string, string, string, Cause.NoSuchElementError, never, Prefix>(
      {
        dataset,
        execution: Execution.batched(2),
        name: "explicit batch",
        score,
        setup,
        task: (inputs, seeded) =>
          Effect.succeed(inputs.map((input) => (seeded === "ready" ? input.input : "not ready"))),
      },
    );

    expectTypeOf(single).toEqualTypeOf<
      Eval.Eval<string, string, Cause.NoSuchElementError, never, Prefix>
    >();
    expectTypeOf(batch).toEqualTypeOf<typeof single>();
  });

  it.effect("makeBatched infers every type from a setup and a task on different services", () =>
    Effect.gen(function* () {
      const categorizer = Eval.makeBatched({
        dataset: movements,
        execution: Execution.batched(20),
        name: "categorizer",
        score: scoreMovement,
        setup: seedMovements,
        task: (page, seeded) =>
          pipe(
            page,
            Effect.forEach((entry) => pickCategory(entry.input, seeded)),
          ),
      });

      expectTypeOf(categorizer).toEqualTypeOf<CategorizerEval>();
      const run = yield* Runner.run(categorizer).pipe(Effect.provide(scriptedServices));
      expect(run.variants[0]?.summary.counts["right"]).toBe(2);
    }),
  );

  it.effect("make infers every type from a setup and a task on different services", () =>
    Effect.gen(function* () {
      const categorizer = Eval.make({
        dataset: movements,
        name: "categorizer",
        score: scoreMovement,
        setup: seedMovements,
        task: (movement, seeded) => pickCategory(movement.input, seeded),
      });

      expectTypeOf(categorizer).toEqualTypeOf<CategorizerEval>();
      const run = yield* Runner.run(categorizer).pipe(Effect.provide(scriptedServices));
      expect(run.variants[0]?.summary.counts["right"]).toBe(2);
    }),
  );
});
