import { Array, Effect, Match, Option, Result, pipe } from "effect";
import { different, exact } from "./agreement.ts";
import * as Compare from "./compare.ts";
import type { Case } from "./dataset.ts";
import { Judgements, scopedTo } from "./judgements.ts";
import { actualStates, expectedStates } from "./observation.ts";
import * as Observations from "./observation.ts";
import type { Observation } from "./observation.ts";
import { verdicts } from "./verdict.ts";
import * as Verdicts from "./verdict.ts";

export type Outcome<O> = Result.Result<O, string>;

export type Scorer<A, O, R = never> = (
  input: Case<A>,
  outcome: Outcome<O>,
) => Effect.Effect<readonly Observation[], never, R>;

export type Expectation<T> =
  | { readonly _tag: "Present"; readonly value: T }
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Unknown" };

export const present = <T>(value: T): Expectation<T> => ({ _tag: "Present", value });

export const absent: Expectation<never> = { _tag: "Absent" };

export const unknown: Expectation<never> = { _tag: "Unknown" };

export const unclassified = "unclassified";

export const extra = "extra";

const NOTHING = "—";
const NOT_KNOWN = "?";
const SET_SEPARATOR = " + ";
const LEAF_SEPARATOR = " | ";
const GROUP_TAG = "group";

const observe = <T>(options: {
  readonly key: string;
  readonly tags: readonly string[];
  readonly expected: Expectation<T>;
  readonly outcome: Outcome<Option.Option<T>>;
  readonly compare: Compare.Compare<T>;
  readonly show: (value: T) => string;
}): Observation => {
  const kind = Match.valueTags(options.expected, {
    Absent: () => expectedStates.absent,
    Present: () => expectedStates.present,
    Unknown: () => expectedStates.unknown,
  });

  const expectedText = Match.valueTags(options.expected, {
    Absent: () => NOTHING,
    Present: ({ value }) => options.show(value),
    Unknown: () => NOT_KNOWN,
  });

  return Result.match(options.outcome, {
    onFailure: (failure) =>
      Observations.errored(options.key, failure, {
        detail: { actual: "", expected: expectedText },
        expected: kind,
        tags: options.tags,
      }),
    onSuccess: Option.match({
      onNone: () =>
        Observations.make({
          actual: actualStates.absent,
          detail: { actual: NOTHING, expected: expectedText },
          expected: kind,
          key: options.key,
          tags: options.tags,
        }),
      onSome: (value) => {
        const detail = { actual: options.show(value), expected: expectedText };

        return Match.valueTags(options.expected, {
          Absent: () =>
            Observations.make({
              actual: actualStates.present,
              detail,
              expected: expectedStates.absent,
              key: options.key,
              tags: options.tags,
            }),
          Present: ({ value: wanted }) =>
            Observations.compared({
              agreement: options.compare(wanted, value),
              detail,
              key: options.key,
              tags: options.tags,
            }),
          Unknown: () =>
            Observations.make({
              actual: actualStates.present,
              detail,
              expected: expectedStates.unknown,
              key: options.key,
              tags: options.tags,
            }),
        });
      },
    }),
  });
};

export const make = <A, O, R>(scorer: Scorer<A, O, R>): Scorer<A, O, R> => scorer;

const withGap =
  (gap: Option.Option<string> | undefined) =>
  (observation: Observation): Observation =>
    Option.match(gap ?? Option.none(), {
      onNone: () => observation,
      onSome: (reason) => Observations.knownGap(reason)(observation),
    });

export const label =
  <A, O>(options: {
    readonly expected: (input: A) => Expectation<string>;
    readonly actual: (output: O) => Option.Option<string>;
    readonly compare?: Compare.Compare<string>;
    readonly key?: string;
  }): Scorer<A, O> =>
  (input, outcome) =>
    Effect.succeed([
      observe({
        compare: options.compare ?? Compare.exact<string>(),
        expected: options.expected(input.input),
        key: Option.match(Option.fromNullishOr(options.key), {
          onNone: () => Observations.rootKey,
          onSome: Observations.keyOf,
        }),
        outcome: pipe(outcome, Result.map(options.actual)),
        show: (value) => value,
        tags: input.tags,
      }),
    ]);

export const set =
  <A, O, T>(options: {
    readonly expected: (input: A) => Expectation<readonly T[]>;
    readonly actual: (output: O) => readonly T[];
    readonly compare: Compare.Compare<readonly T[]>;
    readonly show: (item: T) => string;
    readonly key?: string;
  }): Scorer<A, O> =>
  (input, outcome) => {
    const expected = options.expected(input.input);

    return Effect.succeed([
      observe({
        compare: options.compare,
        expected: Match.valueTags(expected, {
          Absent: () => absent,
          Present: ({ value }) => (value.length === 0 ? absent : expected),
          Unknown: () => unknown,
        }),
        key: Option.match(Option.fromNullishOr(options.key), {
          onNone: () => Observations.rootKey,
          onSome: Observations.keyOf,
        }),
        outcome: pipe(
          outcome,
          Result.map((output) => {
            const items = options.actual(output);

            return items.length === 0 ? Option.none() : Option.some(items);
          }),
        ),
        show: (items) => items.map(options.show).join(SET_SEPARATOR),
        tags: input.tags,
      }),
    ]);
  };

export interface FieldContext<T> {
  readonly expected: T;
  readonly actual: T;
  readonly expectedValue: string;
  readonly actualValue: Option.Option<string>;
}

export interface Field<T> {
  readonly key: string;
  readonly group: string;
  readonly read: (record: T) => Option.Option<string>;
  readonly compare: Compare.Compare<string>;
  readonly covers?: readonly string[];
  readonly excluded?: string;
  readonly exclude?: (context: FieldContext<T>) => Option.Option<string>;
}

export const onlyActualPolicies = {
  exclude: "exclude",
  falsePositive: "falsePositive",
} as const;

export type OnlyActual = (typeof onlyActualPolicies)[keyof typeof onlyActualPolicies];

export interface Leaves<T> {
  readonly of: (record: T) => ReadonlyMap<string, readonly string[]>;
  readonly rule: (path: string) => Option.Option<string>;
}

export const fields =
  <A, T>(options: {
    readonly expected: (input: A) => T;
    readonly fields: readonly Field<T>[];
    readonly onlyActual: OnlyActual;
    readonly leaves?: Leaves<T>;
    readonly gap?: (input: A, key: string) => Option.Option<string>;
  }): Scorer<A, T> =>
  (input, outcome) => {
    const expected = options.expected(input.input);
    const actual = Result.getSuccess(outcome);

    const scoreField = (field: Field<T>): readonly Observation[] => {
      const expectedValue = field.read(expected);
      const actualValue = actual.pipe(Option.flatMap(field.read));

      if (Option.isNone(expectedValue) && Option.isNone(actualValue)) {
        return [];
      }

      const compared = observe({
        compare: field.compare,
        expected: Option.match(expectedValue, { onNone: () => absent, onSome: present }),
        key: Observations.keyOf(field.key),
        outcome: pipe(
          outcome,
          Result.map(() => actualValue),
        ),
        show: (value) => value,
        tags: [...input.tags, `${GROUP_TAG}:${field.group}`],
      });

      const observation = withGap(options.gap?.(input.input, field.key))(compared);

      const known = Option.all({ actual, expectedValue }).pipe(
        Option.flatMap((values) =>
          Verdicts.of(observation) === verdicts.right
            ? Option.none()
            : (field.exclude?.({ ...values, actualValue, expected }) ?? Option.none()),
        ),
      );

      const reason = Option.firstSomeOf([
        Option.isNone(expectedValue) && options.onlyActual === onlyActualPolicies.exclude
          ? Option.some(extra)
          : Option.none(),
        Option.fromNullishOr(field.excluded),
        known,
      ]);

      return [
        Option.match(reason, {
          onNone: () => observation,
          onSome: (why) => Observations.exclude(why)(observation),
        }),
      ];
    };

    const fieldObservations = options.fields.flatMap(scoreField);
    const { leaves } = options;

    if (leaves === undefined || Option.isNone(actual)) {
      return Effect.succeed(fieldObservations);
    }

    const covered = new Set(options.fields.flatMap((field) => field.covers ?? []));
    const expectedLeaves = leaves.of(expected);
    const actualLeaves = leaves.of(actual.value);

    const scoreLeaf = (path: string) => {
      const wanted = expectedLeaves.get(path) ?? [];
      const given = actualLeaves.get(path) ?? [];

      const detail = {
        actual: given.join(LEAF_SEPARATOR),
        expected: wanted.join(LEAF_SEPARATOR),
      };

      const shared = { detail, key: Observations.pathKey(path), tags: input.tags };

      const observation = () => {
        if (wanted.length > 0 && given.length > 0) {
          return Observations.compared({
            ...shared,
            agreement: detail.actual === detail.expected ? exact : different,
          });
        }

        if (wanted.length > 0) {
          return Observations.make({
            ...shared,
            actual: actualStates.absent,
            expected: expectedStates.present,
          });
        }

        return Observations.make({
          ...shared,
          actual: given.length > 0 ? actualStates.present : actualStates.absent,
          expected: expectedStates.absent,
        });
      };

      return Observations.exclude(Option.getOrElse(leaves.rule(path), () => unclassified))(
        observation(),
      );
    };

    return Effect.succeed([
      ...fieldObservations,
      ...[...new Set([...expectedLeaves.keys(), ...actualLeaves.keys()])]
        .filter((path) => !covered.has(path))
        .toSorted()
        .map(scoreLeaf),
    ]);
  };

export const each =
  <A, O, B, P, R>(
    split: {
      readonly expected: (input: A) => readonly Case<B>[];
      readonly actual: (output: O) => ReadonlyMap<string, P>;
      readonly gap?: (input: B, id: string) => Option.Option<string>;
    },
    scorer: Scorer<B, Option.Option<P>, R>,
  ): Scorer<A, O, R> =>
  (input, outcome) =>
    pipe(
      split.expected(input.input),
      Effect.forEach((item) =>
        scorer(
          { ...item, tags: [...input.tags, ...item.tags] },
          pipe(
            outcome,
            Result.map((output) =>
              Option.map(
                Array.findFirst(split.actual(output), ([id]) => id === item.id),
                ([, value]) => value,
              ),
            ),
          ),
        ).pipe(
          Effect.updateService(Judgements, scopedTo(item.id)),
          Effect.map((observations) =>
            observations.map((observation): Observation =>
              withGap(split.gap?.(item.input, item.id))({
                ...observation,
                key: Observations.within(item.id, observation.key),
              }),
            ),
          ),
        ),
      ),
      Effect.map((groups) => groups.flat()),
    );

export const all =
  <A, O, R>(...scorers: readonly Scorer<A, O, R>[]): Scorer<A, O, R> =>
  (input, outcome) =>
    pipe(
      scorers,
      Effect.forEach((scorer) => scorer(input, outcome)),
      Effect.map((groups) => groups.flat()),
    );
