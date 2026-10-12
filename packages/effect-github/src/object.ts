export const whenDefined = <T, U extends object>(
  value: T,
  factory: (value: NonNullable<T>) => U,
) => (value === undefined || value === null ? undefined : factory(value));
