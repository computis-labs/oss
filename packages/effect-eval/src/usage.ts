import { Context, Effect, Exit, Layer, MutableRef, Option, Ref, Schema, Stream } from "effect";
import { LanguageModel, Telemetry } from "effect/ai";
import type { Response } from "effect/ai";
import { whenDefined } from "./object.ts";

const countFields = {
  calls: Schema.Finite,
  costUsd: Schema.OptionFromNullOr(Schema.Finite),
  inputTokens: Schema.Finite,
  outputTokens: Schema.Finite,
  reasoningTokens: Schema.Finite,
};

export const UsageCountsSchema = Schema.Struct(countFields);
export type UsageCounts = typeof UsageCountsSchema.Type;

export const UsageSchema = Schema.Struct({
  ...countFields,
  labels: Schema.Record(Schema.String, UsageCountsSchema),
});
export type Usage = typeof UsageSchema.Type;

export interface Recorded {
  readonly calls?: number;
  readonly costUsd?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly label?: string;
}

export const empty: Usage = {
  calls: 0,
  costUsd: Option.none(),
  inputTokens: 0,
  labels: {},
  outputTokens: 0,
  reasoningTokens: 0,
};

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

const totalCounts = (usages: readonly UsageCounts[]): UsageCounts => {
  const used = usages.filter(
    (usage) =>
      usage.calls > 0 ||
      usage.inputTokens > 0 ||
      usage.outputTokens > 0 ||
      usage.reasoningTokens > 0 ||
      Option.isSome(usage.costUsd),
  );
  return {
    calls: sum(usages.map((usage) => usage.calls)),
    costUsd:
      used.length === 0
        ? Option.none()
        : Option.all(used.map((usage) => usage.costUsd)).pipe(Option.map(sum)),
    inputTokens: sum(usages.map((usage) => usage.inputTokens)),
    outputTokens: sum(usages.map((usage) => usage.outputTokens)),
    reasoningTokens: sum(usages.map((usage) => usage.reasoningTokens)),
  };
};

export const total = (usages: readonly Usage[]): Usage => {
  const labelled = usages.flatMap((usage) => Object.entries(usage.labels));
  const names = [...new Set(labelled.map(([label]) => label))].toSorted();
  return {
    ...totalCounts(usages),
    labels: Object.fromEntries(
      names.map((name) => [
        name,
        totalCounts(labelled.filter(([label]) => label === name).map(([, counts]) => counts)),
      ]),
    ),
  };
};

export const add = (left: Usage, right: Usage): Usage => total([left, right]);

export const fromRecorded = (recorded: Recorded): Usage => {
  const counts: UsageCounts = {
    calls: recorded.calls ?? 1,
    costUsd: Option.fromNullishOr(recorded.costUsd),
    inputTokens: recorded.inputTokens ?? 0,
    outputTokens: recorded.outputTokens ?? 0,
    reasoningTokens: recorded.reasoningTokens ?? 0,
  };
  return {
    ...counts,
    labels: { ...whenDefined(recorded.label, (label) => ({ [label]: counts })) },
  };
};

export const Meter = Context.Reference<{ readonly record: (usage: Usage) => Effect.Effect<void> }>(
  "effect-eval/Meter",
  { defaultValue: () => ({ record: () => Effect.void }) },
);

export const recordUsage = (usage: Usage) =>
  Effect.service(Meter).pipe(Effect.flatMap((meter) => meter.record(usage)));

export const record = (recorded: Recorded) => recordUsage(fromRecorded(recorded));

export const labelled = (usage: Usage, label: string): Usage => {
  const counts: UsageCounts = {
    calls: usage.calls,
    costUsd: usage.costUsd,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
  };
  return { ...counts, labels: { [label]: counts } };
};

export const fromResponse = (usage: Response.Usage): Recorded => ({
  inputTokens: usage.inputTokens.total ?? 0,
  outputTokens: usage.outputTokens.total ?? 0,
  reasoningTokens: usage.outputTokens.reasoning ?? 0,
});

export const track = <A extends { readonly usage: Response.Usage }, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  self.pipe(Effect.tap((response) => record(fromResponse(response.usage))));

export const observe = <A extends { readonly usage: Response.Usage }, E, R>(
  request: Effect.Effect<A, E, R>,
) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* observeRequest() {
      const seen = MutableRef.make(Option.none<Response.Usage>());
      const parent = yield* Effect.serviceOption(Telemetry.CurrentSpanTransformer);
      const exit = yield* restore(request).pipe(
        Effect.provideService(Telemetry.CurrentSpanTransformer, (options) => {
          const finish = options.response.find((part) => part.type === "finish");
          if (finish !== undefined && finish.type === "finish") {
            MutableRef.set(seen, Option.some(finish.usage));
          }
          if (Option.isSome(parent)) {
            parent.value(options);
          }
        }),
        Effect.exit,
      );
      const usage = fromRecorded(
        Option.match(Exit.isSuccess(exit) ? Option.some(exit.value.usage) : MutableRef.get(seen), {
          onNone: () => ({}),
          onSome: fromResponse,
        }),
      );
      return { exit, usage };
    }),
  );

const tracked = <
  F extends (options: never) => Effect.Effect<{ readonly usage: Response.Usage }, unknown, unknown>,
>(
  generate: F,
): F => {
  const wrapped = (options: never) =>
    Effect.uninterruptibleMask((restore) =>
      observe(restore(generate(options))).pipe(
        Effect.flatMap(({ exit, usage }) => recordUsage(usage).pipe(Effect.andThen(exit))),
      ),
    );
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: wrapped takes the options of generate and returns its effect unchanged, after it records one call with the usage of the response, when there is one, also when the request is interrupted.
  return wrapped as F;
};

export const trackLanguageModel: Layer.Layer<
  LanguageModel.LanguageModel,
  never,
  LanguageModel.LanguageModel
> = Layer.effect(
  LanguageModel.LanguageModel,
  Effect.service(LanguageModel.LanguageModel).pipe(
    Effect.map((model): LanguageModel.LanguageModel => ({
      ...model,
      generateObject: tracked(model.generateObject),
      generateText: tracked(model.generateText),
      streamText: (<
        F extends (
          options: never,
        ) => Stream.Stream<
          { readonly type: string; readonly usage?: Response.Usage },
          unknown,
          unknown
        >,
      >(
        stream: F,
      ): F => {
        const wrapped = (options: never) =>
          Stream.unwrap(
            Ref.make(Option.none<Response.Usage>()).pipe(
              Effect.map((seen) =>
                stream(options).pipe(
                  Stream.tap((part) =>
                    part.type === "finish" && part.usage !== undefined
                      ? Ref.set(seen, Option.some(part.usage))
                      : Effect.void,
                  ),
                  Stream.onExit(() =>
                    Ref.get(seen).pipe(
                      Effect.flatMap((usage) =>
                        recordUsage(
                          fromRecorded(
                            Option.match(usage, { onNone: () => ({}), onSome: fromResponse }),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          );
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: wrapped takes the options of stream and returns its parts unchanged, after it records one call per run of the stream with the usage of its finish part, when there is one, also when the stream fails or is interrupted.
        return wrapped as F;
      })(model.streamText),
    })),
  ),
);
