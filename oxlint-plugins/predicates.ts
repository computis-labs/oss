// Each predicate is generic over its input rather than taking `unknown`, so narrowing
// intersects the guard with whatever the caller already knew: `unknown & string` collapses to
// `string`, while `(string | number) & string` keeps the union's own arm.

/** True when the value is a string primitive. */
export const isString = <Value>(value: Value): value is Value & string => typeof value === "string";

/** True when the value is a non-null object, arrays included. */
export const isObject = <Value>(value: Value): value is Value & object =>
  typeof value === "object" && value !== null;

/** True when the value is a non-null, non-array object. */
export const isPlainObject = <Value>(value: Value): value is Value & object =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** True when the value is a number primitive. */
export const isNumber = <Value>(value: Value): value is Value & number => typeof value === "number";

/** True when the value is a keyed object, so its entries can be read by name. */
export const isRecord = <Value>(value: Value): value is Value & Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
