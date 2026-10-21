export const lookup = <V>(table: Readonly<Record<string, V>>, key: string): V | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;

export const whenDefined = <T, U extends object>(
  value: T,
  factory: (value: NonNullable<T>) => U,
) => (value === undefined || value === null ? undefined : factory(value));
