import { Result } from "effect";
import * as CharSet from "../charset.ts";
import { isBmpOnly, parse } from "../pattern/parse.ts";
import type { RegexNode } from "../pattern/parse.ts";
import { render } from "../pattern/render.ts";
import {
  enumerationKey,
  hasXsdLength,
  isBase64Binary,
  isCalendarDate,
  isInDateRange,
  isInDecimalRange,
} from "../runtime.ts";
import type { EnumerationSpace, LengthOptions, RangeOptions } from "../runtime.ts";
import { fail } from "../schema-document.ts";
import type { XsdNode } from "../schema-document.ts";
import { naturalRange } from "./integer-range.ts";
import { impliesNumberLexical } from "./number-pattern.ts";
import { infoOf } from "./restrict.ts";
import type { SimpleSpec } from "./restrict.ts";

export const HELPERS = [
  "xsdBase64Binary",
  "xsdCalendarDate",
  "xsdDateRange",
  "xsdDecimalRange",
  "xsdDefault",
  "xsdDefaultKey",
  "xsdEnumeration",
  "xsdLength",
  "xsdLexical",
  "xsdPattern",
  "xsdText",
] as const;

type Helper = (typeof HELPERS)[number];

interface Scalar {
  readonly code: string;
  readonly helpers: readonly Helper[];
}

interface Check {
  readonly code: string;
  readonly helper?: Helper;
  readonly test: (value: string) => boolean;
}

const regexLiteral = (source: string) => `/${source}/u`;

export const quote = (value: string) => JSON.stringify(value);

const INTEGER = /^[+-]?[0-9]+$/u;

const lengthChecks = (spec: SimpleSpec, codePoints: boolean): readonly Check[] => {
  const { maxLength, minLength } = spec;
  const options: LengthOptions = {
    collapse: spec.whiteSpace === "collapse",
    maximum: maxLength,
    minimum: minLength,
  };
  const test = (value: string) => hasXsdLength(value, options);
  if (minLength === undefined && maxLength === undefined) {
    return [];
  }
  if (codePoints) {
    const fields = [
      `collapse: ${String(options.collapse)}`,
      ...(maxLength === undefined ? [] : [`maximum: ${String(maxLength)}`]),
      ...(minLength === undefined ? [] : [`minimum: ${String(minLength)}`]),
    ];
    return [{ code: `xsdLength({ ${fields.join(", ")} })`, helper: "xsdLength", test }];
  }
  if (minLength !== undefined && maxLength !== undefined) {
    return [{ code: `Schema.isLengthBetween(${String(minLength)}, ${String(maxLength)})`, test }];
  }
  return [
    minLength === undefined
      ? { code: `Schema.isMaxLength(${String(maxLength)})`, test }
      : { code: `Schema.isMinLength(${String(minLength)})`, test },
  ];
};

const regexCheck = (helper: Helper, source: string, args: readonly string[]): Check => {
  const regExp = new RegExp(source, "u");
  return {
    code: `${helper}(${[regexLiteral(source), ...args].join(", ")})`,
    helper,
    test: (value) => regExp.test(value),
  };
};

const ENUMERATION_SPACES = {
  binary: "base64Binary",
  date: "dateTime",
  number: "decimal",
} as const satisfies Record<string, EnumerationSpace>;

export const emitScalar = (spec: SimpleSpec, node: XsdNode) =>
  Result.gen(function* emitSimpleType() {
    const info = infoOf(spec.builtin);
    const enumerated = spec.enumerations.length > 0;
    const checks: Check[] = [];

    const emitEnumeration = (last: readonly string[]) =>
      Result.gen(function* emitEnumerationType() {
        const text = info.family === "text";
        const space: EnumerationSpace =
          info.family === "text" ? spec.whiteSpace : ENUMERATION_SPACES[info.family];
        const valueKey = (value: string) => {
          const key = enumerationKey(space, value);
          return text && key !== value ? null : key;
        };
        const passes = (value: string) => checks.every((check) => check.test(value));
        const layers = spec.enumerations.map(
          (enumeration) => new Set(enumeration.map((value) => valueKey(value))),
        );
        const seen = new Set<string>();
        const allowed: string[] = [];
        for (const value of last) {
          const key = valueKey(value);
          if (
            key !== null &&
            !seen.has(key) &&
            layers.every((layer) => layer.has(key)) &&
            (!text || passes(value))
          ) {
            seen.add(key);
            allowed.push(value);
          }
        }
        const [first] = allowed;
        if (first === undefined) {
          return yield* fail(node, "No enumeration value satisfies the other facets.");
        }
        if (
          text &&
          (space === "preserve" ||
            (space === "replace" && allowed.every((value) => !value.includes(" "))))
        ) {
          const scalar: Scalar = {
            code:
              allowed.length === 1
                ? `Schema.Literal(${quote(first)})`
                : `Schema.Literals([${allowed.map(quote).join(", ")}])`,
            helpers: [],
          };
          return scalar;
        }
        const examples = allowed.filter(passes);
        const enumeration = `xsdEnumeration(${[
          quote(space),
          `[${allowed.map(quote).join(", ")}]`,
          ...(examples.length === allowed.length ? [] : [`[${examples.map(quote).join(", ")}]`]),
        ].join(", ")})`;
        const scalar: Scalar = {
          code: `Schema.String.check(${[...checks.map((check) => check.code), enumeration].join(", ")})`,
          helpers: [
            ...checks.flatMap((check) => (check.helper === undefined ? [] : [check.helper])),
            "xsdEnumeration",
          ],
        };
        return scalar;
      });

    const integerGenerator = (): string | null => {
      const { maxInclusive, minInclusive } = spec;
      if (
        spec.builtin !== "integer" ||
        minInclusive === undefined ||
        maxInclusive === undefined ||
        !INTEGER.test(minInclusive) ||
        !INTEGER.test(maxInclusive)
      ) {
        return null;
      }
      const low = BigInt(minInclusive);
      const high = BigInt(maxInclusive);
      if (high < 0n) {
        return `^(?:-(?:${naturalRange(-high, -low)}))$`;
      }
      if (low < 0n) {
        return `^(?:-(?:${naturalRange(1n, -low)})|${naturalRange(0n, high)})$`;
      }
      return `^(?:${naturalRange(low, high)})$`;
    };

    const textChecks = (): readonly Check[] => {
      const XML_CHARACTER: RegexNode = { kind: "set", set: CharSet.XML_CHAR };
      if (info.family !== "text") {
        return [];
      }
      if (spec.patterns.length > 0) {
        const bmp = spec.patterns.every((step) => isBmpOnly(step.node));
        return lengthChecks(spec, !bmp || spec.whiteSpace === "collapse");
      }
      if (spec.whiteSpace !== "collapse") {
        const source = render(
          { kind: "repeat", max: spec.maxLength, min: spec.minLength ?? 0, node: XML_CHARACTER },
          spec.whiteSpace,
        );
        return [regexCheck("xsdText", source, [])];
      }
      const source = render(
        { kind: "repeat", max: undefined, min: 0, node: XML_CHARACTER },
        "preserve",
      );
      return [regexCheck("xsdText", source, []), ...lengthChecks(spec, true)];
    };

    const rangeChecks = (): readonly Check[] => {
      if (spec.minInclusive === undefined && spec.maxInclusive === undefined) {
        return [];
      }
      const range: RangeOptions = { maximum: spec.maxInclusive, minimum: spec.minInclusive };
      const fields = [
        ...(spec.maxInclusive === undefined ? [] : [`maximum: ${quote(spec.maxInclusive)}`]),
        ...(spec.minInclusive === undefined ? [] : [`minimum: ${quote(spec.minInclusive)}`]),
      ].join(", ");
      return [
        info.family === "date"
          ? {
              code: `xsdDateRange({ ${fields} })`,
              helper: "xsdDateRange",
              test: (value) => isInDateRange(value, range),
            }
          : {
              code: `xsdDecimalRange({ ${fields} })`,
              helper: "xsdDecimalRange",
              test: (value) => isInDecimalRange(value, range),
            },
      ];
    };

    const lexicalImplied =
      info.family === "number" &&
      spec.patterns.some((step) => impliesNumberLexical(step.node, spec.builtin === "decimal"));
    if (info.lexical !== undefined && !lexicalImplied) {
      const lexical = parse(info.lexical);
      if (Result.isFailure(lexical)) {
        return yield* fail(node, lexical.failure);
      }
      const source = render(
        lexical.success,
        info.family === "date" && !enumerated ? "preserve" : spec.whiteSpace,
      );
      const generator = integerGenerator() ?? render(lexical.success, "canonical");
      checks.push(
        regexCheck("xsdLexical", source, [
          quote(`xs:${spec.builtin}`),
          ...(spec.patterns.length === 0 && !enumerated ? [regexLiteral(generator)] : []),
        ]),
      );
    }
    if (spec.builtin === "base64Binary") {
      checks.push({ code: "xsdBase64Binary", helper: "xsdBase64Binary", test: isBase64Binary });
    }
    if (info.family === "date") {
      checks.push({ code: "xsdCalendarDate", helper: "xsdCalendarDate", test: isCalendarDate });
    }
    for (const step of spec.patterns) {
      checks.push(
        regexCheck("xsdPattern", render(step.node, spec.whiteSpace), [
          quote(step.source),
          ...(spec.whiteSpace === "collapse" && !enumerated
            ? [regexLiteral(render(step.node, "canonical"))]
            : []),
        ]),
      );
    }
    checks.push(...textChecks(), ...rangeChecks());
    const [lastEnumeration] = spec.enumerations.toReversed();
    if (lastEnumeration === undefined) {
      const scalar: Scalar = {
        code: `Schema.String.check(${checks.map((check) => check.code).join(", ")})`,
        helpers: checks.flatMap((check) => (check.helper === undefined ? [] : [check.helper])),
      };
      return scalar;
    }
    return yield* emitEnumeration(lastEnumeration);
  });
