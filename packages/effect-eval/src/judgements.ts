import { Context, Effect, Option } from "effect";
import type { Schema } from "effect";
import type { Judgement } from "./events.ts";
import { within } from "./observation.ts";

export interface Memory {
  readonly lookup: (key: string, hash: string) => Option.Option<Schema.Json>;
  readonly record: (judgement: Judgement) => Effect.Effect<void>;
}

export const Judgements = Context.Reference<Memory>("effect-eval/Judgements", {
  defaultValue: () => ({ lookup: () => Option.none(), record: () => Effect.void }),
});

export const scopedTo =
  (parent: string) =>
  (self: Memory): Memory => ({
    lookup: (key, hash) => self.lookup(within(parent, key), hash),
    record: (judgement) => self.record({ ...judgement, key: within(parent, judgement.key) }),
  });

export const memory = (
  stored: readonly Judgement[],
  record: (judgement: Judgement) => Effect.Effect<void>,
): Memory => ({
  lookup: (key, hash) =>
    Option.map(
      Option.fromNullishOr(
        stored.find((judgement) => judgement.key === key && judgement.hash === hash),
      ),
      (judgement) => judgement.result,
    ),
  record,
});
