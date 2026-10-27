import { Array as Arr, Layer, pipe } from "effect";

export interface Variant<ROut, E = never, RIn = never> {
  readonly name: string;
  readonly layer: Layer.Layer<ROut, E, RIn>;
}

export const make = <ROut, E, RIn>(
  name: string,
  layer: Layer.Layer<ROut, E, RIn>,
): Variant<ROut, E, RIn> => ({ layer, name });

export const none: Variant<never> = make("default", Layer.empty);

const AXIS_SEPARATOR = " · ";

type AnyVariant = Variant<never, unknown, unknown>;

type Axes = Readonly<Record<string, readonly AnyVariant[]>>;

type Chosen<A extends Axes> = A[keyof A][number];

type Provided<V> = V extends Variant<infer ROut, unknown, unknown> ? ROut : never;

type Failure<V> = V extends Variant<never, infer E, unknown> ? E : never;

type Needed<V> = V extends Variant<never, unknown, infer RIn> ? RIn : never;

type LackedBy<S, V> = V extends AnyVariant ? (S extends Provided<V> ? never : true) : never;

type Common<V> =
  Provided<V> extends infer S
    ? S extends unknown
      ? [LackedBy<S, V>] extends [never]
        ? S
        : never
      : never
    : never;

export type Combined<A extends Axes> = Variant<
  { readonly [K in keyof A]: Common<A[K][number]> }[keyof A],
  Failure<Chosen<A>>,
  Needed<Chosen<A>>
>;

type Choice = readonly [axis: string, variant: AnyVariant];

const combinations = (
  axes: readonly (readonly [string, readonly AnyVariant[]])[],
): readonly (readonly Choice[])[] => {
  const [first, ...rest] = axes;

  if (first === undefined) {
    return [[]];
  }

  const tails = combinations(rest);

  return first[1].flatMap((variant) =>
    tails.map((tail): readonly Choice[] => [[first[0], variant], ...tail]),
  );
};

export const matrix = <const A extends Axes>(axes: A): readonly Combined<A>[] =>
  combinations(Object.entries(axes))
    .filter(Arr.isReadonlyArrayNonEmpty)
    .map((choices) => {
      const combined = make(
        choices.map(([axis, variant]) => `${axis}=${variant.name}`).join(AXIS_SEPARATOR),
        Layer.mergeAll(
          ...pipe(
            choices,
            Arr.map(([, variant]) => variant.layer),
          ),
        ),
      );

      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: each combination takes one variant of every axis, so its merged layer provides at least the services common to the alternatives of each axis, fails and needs at most what any of them does, which is what Combined<A> spells out.
      return combined as Combined<A>;
    });
