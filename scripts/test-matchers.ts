import { expect } from "@effect/vitest";
import { Predicate } from "effect";

export const tagged = <Fields extends object>(tag: string, fields: Fields) => ({
  $$typeof: Symbol.for("jest.asymmetricMatcher"),
  asymmetricMatch: <Value>(
    value: Value
  ): value is Value & Record<"_tag", string> => {
    if (!Predicate.isTagged(value, tag)) {
      return false;
    }

    try {
      expect(value).toMatchObject(fields);

      return true;
    } catch {
      return false;
    }
  },
  sample: fields,
  toAsymmetricMatcher: () => `Tagged<${tag}>`,
  toString: () => `Tagged<${tag}>`,
});
