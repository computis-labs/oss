import { Option, Schema } from "effect";
import { AgreementSchema } from "./agreement.ts";
import type { Agreement } from "./agreement.ts";

export const expectedStates = {
  absent: "absent",
  present: "present",
  unknown: "unknown",
} as const;
export type ExpectedState = (typeof expectedStates)[keyof typeof expectedStates];

export const actualStates = {
  absent: "absent",
  present: "present",
} as const;
export type ActualState = (typeof actualStates)[keyof typeof actualStates];

const PATH_SEPARATOR = "/";
const ESCAPE = "\\";
const EMPTY_SEGMENT = `${ESCAPE}_`;

export const rootKey = "";

export const keyOf = (segment: string) =>
  segment === ""
    ? EMPTY_SEGMENT
    : segment
        .replaceAll(ESCAPE, `${ESCAPE}${ESCAPE}`)
        .replaceAll(PATH_SEPARATOR, `${ESCAPE}${PATH_SEPARATOR}`);

export const within = (parent: string, key: string) =>
  key === rootKey ? keyOf(parent) : `${keyOf(parent)}${PATH_SEPARATOR}${key}`;

export const pathKey = (path: string) => path.split(PATH_SEPARATOR).map(keyOf).join(PATH_SEPARATOR);

export const DetailSchema = Schema.Struct({
  actual: Schema.String,
  expected: Schema.String,
  note: Schema.optionalKey(Schema.String),
});
export type Detail = typeof DetailSchema.Type;

export const ObservationSchema = Schema.Struct({
  actual: Schema.Literals([actualStates.present, actualStates.absent]),
  agreement: Schema.OptionFromNullOr(AgreementSchema),
  detail: DetailSchema,
  excluded: Schema.OptionFromNullOr(Schema.String),
  expected: Schema.Literals([
    expectedStates.present,
    expectedStates.absent,
    expectedStates.unknown,
  ]),
  failure: Schema.OptionFromNullOr(Schema.String),
  gap: Schema.OptionFromNullOr(Schema.String),
  key: Schema.String,
  tags: Schema.Array(Schema.String),
}).check(
  Schema.makeFilter(
    (observation): true | string => {
      if (Option.isSome(observation.failure)) {
        return observation.actual === actualStates.absent && Option.isNone(observation.agreement)
          ? true
          : "a failed observation has no actual value and no agreement";
      }
      if (
        observation.expected === expectedStates.present &&
        observation.actual === actualStates.present
      ) {
        return Option.isSome(observation.agreement)
          ? true
          : "an expected and an actual value need an agreement: use Observation.compared";
      }
      return Option.isNone(observation.agreement)
        ? true
        : "an agreement needs an expected and an actual value";
    },
    { expected: "a coherent observation" },
  ),
);
export type Observation = typeof ObservationSchema.Type;

const blank = {
  agreement: Option.none(),
  excluded: Option.none(),
  failure: Option.none(),
  gap: Option.none(),
};

export const compared = (input: {
  readonly key: string;
  readonly tags?: readonly string[];
  readonly agreement: Agreement;
  readonly detail: Detail;
}): Observation =>
  ObservationSchema.make({
    ...blank,
    actual: actualStates.present,
    agreement: Option.some(input.agreement),
    detail: input.detail,
    expected: expectedStates.present,
    key: input.key,
    tags: input.tags ?? [],
  });

export const make = (
  input: {
    readonly key: string;
    readonly tags?: readonly string[];
    readonly detail: Detail;
  } & (
    | {
        readonly expected: typeof expectedStates.absent | typeof expectedStates.unknown;
        readonly actual: ActualState;
      }
    | {
        readonly expected: typeof expectedStates.present;
        readonly actual: typeof actualStates.absent;
      }
  ),
): Observation =>
  ObservationSchema.make({
    ...blank,
    actual: input.actual,
    detail: input.detail,
    expected: input.expected,
    key: input.key,
    tags: input.tags ?? [],
  });

export const errored = (
  key: string,
  failure: string,
  options: {
    readonly expected: ExpectedState;
    readonly tags?: readonly string[];
    readonly detail?: Detail;
  },
): Observation => ({
  ...blank,
  actual: actualStates.absent,
  detail: options.detail ?? { actual: "", expected: "" },
  expected: options.expected,
  failure: Option.some(failure),
  key,
  tags: options.tags ?? [],
});

export const knownGap =
  (reason: string) =>
  (self: Observation): Observation => ({ ...self, gap: Option.some(reason) });

export const exclude =
  (reason: string) =>
  (self: Observation): Observation => ({ ...self, excluded: Option.some(reason) });

export const tagged =
  (...tags: readonly string[]) =>
  (self: Observation): Observation => ({ ...self, tags: [...self.tags, ...tags] });
