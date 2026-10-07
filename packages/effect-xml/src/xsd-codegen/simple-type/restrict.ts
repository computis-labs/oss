import { Array as Arr, Result } from "effect";
import type { XsdCodegenError } from "../../errors/xsd-codegen-error.ts";
import { choice, parse } from "../pattern/parse.ts";
import type { RegexNode } from "../pattern/parse.ts";
import type { WhiteSpace } from "../pattern/render.ts";
import { compareDates, compareDecimal, enumerationKey } from "../runtime.ts";
import { fail } from "../schema-document.ts";
import type { XsdNode } from "../schema-document.ts";

export type Builtin =
  | "base64Binary"
  | "date"
  | "dateTime"
  | "decimal"
  | "integer"
  | "normalizedString"
  | "string"
  | "token";

interface BuiltinInfo {
  readonly family: "binary" | "date" | "number" | "text";
  readonly lexical: string | undefined;
  readonly whiteSpace: WhiteSpace;
}

const DATE_LEXICAL = "[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])";
const TIME_LEXICAL = String.raw`T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?`;
const TIMEZONE_LEXICAL = String.raw`(Z|[+\-]((0[0-9]|1[0-3]):[0-5][0-9]|14:00))?`;

const BUILTINS = {
  base64Binary: { family: "binary", lexical: undefined, whiteSpace: "collapse" },
  date: { family: "date", lexical: `${DATE_LEXICAL}${TIMEZONE_LEXICAL}`, whiteSpace: "collapse" },
  dateTime: {
    family: "date",
    lexical: `${DATE_LEXICAL}${TIME_LEXICAL}${TIMEZONE_LEXICAL}`,
    whiteSpace: "collapse",
  },
  decimal: {
    family: "number",
    lexical: String.raw`[+\-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)`,
    whiteSpace: "collapse",
  },
  integer: { family: "number", lexical: String.raw`[+\-]?[0-9]+`, whiteSpace: "collapse" },
  normalizedString: { family: "text", lexical: undefined, whiteSpace: "replace" },
  string: { family: "text", lexical: undefined, whiteSpace: "preserve" },
  token: { family: "text", lexical: undefined, whiteSpace: "collapse" },
} satisfies Record<Builtin, BuiltinInfo>;

export const isBuiltin = (name: string): name is Builtin => Object.hasOwn(BUILTINS, name);

interface PatternStep {
  readonly node: RegexNode;
  readonly source: string;
}

export interface SimpleSpec {
  readonly builtin: Builtin;
  readonly enumerations: readonly (readonly string[])[];
  readonly maxInclusive: string | undefined;
  readonly maxLength: number | undefined;
  readonly minInclusive: string | undefined;
  readonly minLength: number | undefined;
  readonly patterns: readonly PatternStep[];
  readonly whiteSpace: WhiteSpace;
}

export const infoOf = (builtin: Builtin): BuiltinInfo => BUILTINS[builtin];

export const builtinSpec = (builtin: Builtin): SimpleSpec => ({
  builtin,
  enumerations: [],
  maxInclusive: undefined,
  maxLength: undefined,
  minInclusive: undefined,
  minLength: undefined,
  patterns: [],
  whiteSpace: infoOf(builtin).whiteSpace,
});

type Facets = Pick<
  SimpleSpec,
  "maxInclusive" | "maxLength" | "minInclusive" | "minLength" | "whiteSpace"
> & {
  readonly enumeration: readonly string[];
  readonly patterns: readonly PatternStep[];
};

const WHITESPACE_ORDER: readonly WhiteSpace[] = ["preserve", "replace", "collapse"];

const facetValue = (node: XsdNode) => {
  const value = node.attributes.get("value");
  return value === undefined ? fail(node, "The facet has no value.") : Result.succeed(value);
};

export const restrict = (base: SimpleSpec, restriction: XsdNode) =>
  Result.gen(function* restrictSimpleType() {
    const info = infoOf(base.builtin);
    const decimalCompare = info.family === "number" ? compareDecimal : undefined;
    const compare = base.builtin === "date" ? compareDates : decimalCompare;

    const applyLength = (facets: Facets, facet: XsdNode) =>
      Result.gen(function* applyLengthFacet() {
        if (info.family !== "text") {
          return yield* fail(facet, `The ${facet.local} facet is only supported on string types.`);
        }
        const text = (yield* facetValue(facet)).trim();
        if (!/^[0-9]+$/u.test(text)) {
          return yield* fail(facet, `The facet value ${text} is not a non-negative integer.`);
        }
        const value = Number(text);
        return {
          ...facets,
          maxLength:
            facet.local === "minLength"
              ? facets.maxLength
              : Math.min(facets.maxLength ?? value, value),
          minLength:
            facet.local === "maxLength" ? facets.minLength : Math.max(facets.minLength ?? 0, value),
        };
      });

    const applyRange = (facets: Facets, facet: XsdNode) =>
      Result.gen(function* applyRangeFacet() {
        const value = (yield* facetValue(facet)).trim();
        if (compare === undefined) {
          return yield* fail(
            facet,
            `The ${facet.local} facet is only supported on xs:decimal, xs:integer and xs:date.`,
          );
        }
        if (compare(value, value) === null) {
          return yield* fail(facet, `The ${facet.local} value ${value} is not supported.`);
        }
        const { maxInclusive, minInclusive } = facets;
        if (facet.local === "minInclusive") {
          return minInclusive === undefined || (compare(value, minInclusive) ?? 0) > 0
            ? { ...facets, minInclusive: value }
            : facets;
        }
        return maxInclusive === undefined || (compare(value, maxInclusive) ?? 0) < 0
          ? { ...facets, maxInclusive: value }
          : facets;
      });

    const applyWhiteSpace = (facets: Facets, facet: XsdNode) =>
      Result.gen(function* applyWhiteSpaceFacet() {
        const value = yield* facetValue(facet);
        const next = WHITESPACE_ORDER.find((candidate) => candidate === value);
        if (next === undefined) {
          return yield* fail(facet, `The whiteSpace value ${value} is not valid.`);
        }
        if (WHITESPACE_ORDER.indexOf(next) < WHITESPACE_ORDER.indexOf(facets.whiteSpace)) {
          return yield* fail(
            facet,
            `The whiteSpace facet cannot relax ${facets.whiteSpace} to ${next}.`,
          );
        }
        return { ...facets, whiteSpace: next };
      });

    const facets = yield* Arr.reduce<XsdNode, Result.Result<Facets, XsdCodegenError>>(
      restriction.children,
      Result.succeed({
        enumeration: [],
        maxInclusive: base.maxInclusive,
        maxLength: base.maxLength,
        minInclusive: base.minInclusive,
        minLength: base.minLength,
        patterns: [],
        whiteSpace: base.whiteSpace,
      }),
      (previous, facet) =>
        Result.gen(function* applyFacet() {
          const current = yield* previous;
          if (facet.local === "pattern") {
            const source = yield* facetValue(facet);
            const parsed = parse(source);
            if (Result.isFailure(parsed)) {
              return yield* fail(facet, `${parsed.failure}.`);
            }
            return {
              ...current,
              patterns: [...current.patterns, { node: parsed.success, source }],
            };
          }
          if (facet.local === "enumeration") {
            return { ...current, enumeration: [...current.enumeration, yield* facetValue(facet)] };
          }
          if (["length", "minLength", "maxLength"].includes(facet.local)) {
            return yield* applyLength(current, facet);
          }
          if (facet.local === "minInclusive" || facet.local === "maxInclusive") {
            return yield* applyRange(current, facet);
          }
          if (facet.local === "whiteSpace") {
            return yield* applyWhiteSpace(current, facet);
          }
          if (facet.local !== "simpleType") {
            return yield* fail(facet, `The ${facet.local} facet is not supported.`);
          }
          return current;
        }),
    );
    const { enumeration, maxInclusive, maxLength, minInclusive, minLength, patterns, whiteSpace } =
      facets;
    if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
      return yield* fail(restriction, "The length facets admit no value.");
    }
    const normalize = (value: string) => enumerationKey(base.whiteSpace, value) ?? value;
    const spec: SimpleSpec = {
      builtin: base.builtin,
      enumerations:
        enumeration.length === 0
          ? base.enumerations
          : [...base.enumerations, enumeration.map(normalize)],
      maxInclusive,
      maxLength,
      minInclusive,
      minLength,
      patterns:
        patterns.length === 0
          ? base.patterns
          : [
              ...base.patterns,
              {
                node: choice(patterns.map((step) => step.node)),
                source: patterns.map((step) => step.source).join("|"),
              },
            ],
      whiteSpace,
    };
    return spec;
  });
