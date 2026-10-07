import { Effect, Match, Schema, SchemaGetter } from "effect";

export { element, root } from "../annotations.ts";

export type XsdDomain = Readonly<Record<string, (self: Schema.String) => Schema.Top>>;

const EDGE_WHITESPACE = /^[\t\n\r ]+|[\t\n\r ]+$/gu;
const INNER_WHITESPACE = /[\t\n\r ]+/gu;
const DECIMAL = /^[\t\n\r ]*(?<sign>[+-]?)(?<integer>[0-9]*)(?:\.(?<fraction>[0-9]*))?[\t\n\r ]*$/u;
const DATE =
  /^[\t\n\r ]*(?<year>[0-9]{4})-(?<month>[0-9]{2})-(?<day>[0-9]{2})(?<rest>[^\t\n\r ]*)/u;
const TIMEZONE = /(?:Z|[+-][0-9]{2}:[0-9]{2})$/u;
const DATE_TIME =
  /^(?<year>[0-9]{4})-(?<month>[0-9]{2})-(?<day>[0-9]{2})(?:T(?<hour>[0-9]{2}):(?<minute>[0-9]{2}):(?<second>[0-9]{2})(?:\.(?<fraction>[0-9]*))?)?(?<timezone>Z|(?<sign>[+-])(?<zoneHour>[0-9]{2}):(?<zoneMinute>[0-9]{2}))?$/u;
const DIGIT = /[0-9]/u;
const SIMPLE_DECIMAL = /^[+-]?[0-9]+(?:\.[0-9]*)?$/u;
// A decimal of at most 15 characters has at most 15 significant digits, so its double keeps its order.
const MAX_EXACT_DIGITS = 15;
const LINE_WHITESPACE = /[\t\n\r]/gu;
const BASE64_WHITESPACE = /[\t\n\r ]/gu;
const REGEX_SYNTAX = /[$()*+./?[\\\]^{|}]/gu;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_CANONICAL = String.raw`^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=|[A-Za-z0-9+/][AQgw]==)?$`;
const SURROGATE_PAIR = /[\u{10000}-\u{10FFFF}]/gu;
const BASE64_LENIENT = /^(?<digits>[A-Za-z0-9+/]*)(?<padding>=*)$/u;
const TIMEZONE_MARGIN_DAYS = 2;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export const xsdPattern = (regExp: RegExp, xsd: string, generator: RegExp = regExp) =>
  Schema.isPattern(regExp, {
    arbitraryConstraint: { patterns: [{ flags: generator.flags, source: generator.source }] },
    expected: `a string matching the XSD pattern ${xsd}`,
  });

export const xsdLexical = (regExp: RegExp, type: string, generator?: RegExp) =>
  Schema.isPattern(regExp, {
    arbitraryConstraint:
      generator === undefined
        ? undefined
        : { patterns: [{ flags: generator.flags, source: generator.source }] },
    expected: `a valid ${type} value`,
  });

export const xsdText = (regExp: RegExp) =>
  Schema.isPattern(regExp, { expected: "a string of XML characters of the allowed length" });

export const collapse = (value: string) =>
  value.replaceAll(EDGE_WHITESPACE, "").replaceAll(INNER_WHITESPACE, " ");

export interface LengthOptions {
  readonly collapse: boolean;
  readonly maximum?: number | undefined;
  readonly minimum?: number | undefined;
}

export const hasXsdLength = (value: string, options: LengthOptions) => {
  const text = options.collapse ? collapse(value) : value;
  const length = text.length - (text.match(SURROGATE_PAIR)?.length ?? 0);
  return (
    (options.minimum === undefined || length >= options.minimum) &&
    (options.maximum === undefined || length <= options.maximum)
  );
};

export const xsdLength = (options: LengthOptions) => {
  const { maximum, minimum } = options;
  const expected = Match.value(options).pipe(
    Match.when({ minimum: Match.undefined }, () => `at most ${String(maximum)}`),
    Match.when({ maximum: Match.undefined }, () => `at least ${String(minimum)}`),
    Match.when(
      () => minimum === maximum,
      () => `exactly ${String(minimum)}`,
    ),
    Match.orElse(() => `between ${String(minimum)} and ${String(maximum)}`),
  );
  return Schema.makeFilter((value: string) => hasXsdLength(value, options), {
    arbitraryConstraint: { maxLength: maximum, minLength: minimum },
    expected: `a string of ${expected} characters${options.collapse ? " after whitespace collapsing" : ""}`,
  });
};

interface Decimal {
  readonly fraction: string;
  readonly integer: string;
  readonly negative: boolean;
}

const parseDecimal = (value: string): Decimal | null => {
  const groups = DECIMAL.exec(value)?.groups;
  if (groups === undefined) {
    return null;
  }
  const integer = (groups["integer"] ?? "").replace(/^0+/u, "");
  const fraction = (groups["fraction"] ?? "").replace(/0+$/u, "");
  return { fraction, integer, negative: groups["sign"] === "-" && `${integer}${fraction}` !== "" };
};

const isExactNumber = (value: string) =>
  value.length <= MAX_EXACT_DIGITS && SIMPLE_DECIMAL.test(value);

const compareDigits = (left: string, right: string) => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

const compareParsedDecimal = (left: Decimal, right: Decimal) => {
  if (left.negative !== right.negative) {
    return left.negative ? -1 : 1;
  }
  const integerOrder =
    left.integer.length === right.integer.length
      ? compareDigits(left.integer, right.integer)
      : Math.sign(left.integer.length - right.integer.length);
  const magnitude =
    integerOrder === 0 ? compareDigits(left.fraction, right.fraction) : integerOrder;
  return left.negative ? -magnitude : magnitude;
};

export const compareDecimal = (left: string, right: string): number | null => {
  const parsedLeft = parseDecimal(left);
  const parsedRight = parseDecimal(right);
  return parsedLeft === null || parsedRight === null
    ? null
    : compareParsedDecimal(parsedLeft, parsedRight);
};

export interface RangeOptions {
  readonly maximum?: string | undefined;
  readonly minimum?: string | undefined;
}

const describeRange = ({ maximum, minimum }: RangeOptions) =>
  [
    ...(minimum === undefined ? [] : [`at least ${minimum}`]),
    ...(maximum === undefined ? [] : [`at most ${maximum}`]),
  ].join(" and ");

const decimalRange = ({ maximum, minimum }: RangeOptions) => {
  if (minimum === undefined && maximum === undefined) {
    return () => true;
  }
  const lower = minimum === undefined ? undefined : parseDecimal(minimum);
  const upper = maximum === undefined ? undefined : parseDecimal(maximum);
  if (lower === null || upper === null) {
    return () => false;
  }
  const exactBounds = [minimum, maximum].every(
    (bound) => bound === undefined || isExactNumber(bound),
  );
  const lowest = minimum === undefined ? -Infinity : Number(minimum);
  const highest = maximum === undefined ? Infinity : Number(maximum);
  return (value: string) => {
    if (exactBounds && isExactNumber(value)) {
      const number = Number(value);
      return number >= lowest && number <= highest;
    }
    const decimal = parseDecimal(value);
    return (
      decimal !== null &&
      (lower === undefined || compareParsedDecimal(decimal, lower) >= 0) &&
      (upper === undefined || compareParsedDecimal(decimal, upper) <= 0)
    );
  };
};

export const isInDecimalRange = (value: string, options: RangeOptions) =>
  decimalRange(options)(value);

export const xsdDecimalRange = (options: RangeOptions) => {
  const isInRange = decimalRange(options);
  return Schema.makeFilter((value: string) => isInRange(value), {
    expected: `a number ${describeRange(options)}`,
  });
};

const dayNumber = (groups: Record<string, string | undefined>): number | null => {
  const year = Number(groups["year"]);
  const month = Number(groups["month"]);
  const day = Number(groups["day"]);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const monthDays = month === 2 && leap ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);
  if (year === 0 || day < 1 || day > monthDays) {
    return null;
  }
  const shifted = month <= 2 ? year - 1 : year;
  const era = Math.floor(shifted / 400);
  const yearOfEra = shifted - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra;
};

const parseDate = (value: string): { readonly day: number; readonly timezone: boolean } | null => {
  const groups = DATE.exec(value)?.groups;
  const day = groups === undefined ? null : dayNumber(groups);
  return groups === undefined || day === null
    ? null
    : { day, timezone: TIMEZONE.test(groups["rest"] ?? "") };
};

export const isCalendarDate = (value: string) => parseDate(value) !== null;

export const xsdCalendarDate = Schema.makeFilter((value: string) => isCalendarDate(value), {
  expected: "a date that exists in the Gregorian calendar",
});

export const compareDates = (left: string, right: string) => {
  const leftDate = parseDate(left);
  const rightDate = parseDate(right);
  return leftDate === null || rightDate === null || leftDate.timezone || rightDate.timezone
    ? null
    : Math.sign(leftDate.day - rightDate.day);
};

const dateRange = ({ maximum, minimum }: RangeOptions) => {
  const lower = minimum === undefined ? undefined : parseDate(minimum);
  const upper = maximum === undefined ? undefined : parseDate(maximum);
  if (lower === null || upper === null) {
    return () => false;
  }
  return (value: string) => {
    const date = parseDate(value);
    if (date === null) {
      return false;
    }
    const margin = date.timezone ? TIMEZONE_MARGIN_DAYS : 0;
    return (
      (lower === undefined || date.day >= lower.day + margin) &&
      (upper === undefined || date.day <= upper.day - margin)
    );
  };
};

export const isInDateRange = (value: string, options: RangeOptions) => dateRange(options)(value);

export const xsdDateRange = (options: RangeOptions) => {
  const isInRange = dateRange(options);
  return Schema.makeFilter((value: string) => isInRange(value), {
    expected: `a date ${describeRange(options)}`,
  });
};

type EnumerationKey = (value: string) => string | null;

const ENUMERATION_KEYS = {
  base64Binary: (value) => value.replaceAll(BASE64_WHITESPACE, ""),
  collapse,
  dateTime: (value): string | null => {
    const groups = DATE_TIME.exec(collapse(value))?.groups;
    const day = groups === undefined ? null : dayNumber(groups);
    if (groups === undefined || day === null) {
      return null;
    }
    const { timezone } = groups;
    const zoneMinutes = Number(groups["zoneHour"] ?? 0) * 60 + Number(groups["zoneMinute"] ?? 0);
    const minutes =
      day * 1440 +
      Number(groups["hour"] ?? 0) * 60 +
      Number(groups["minute"] ?? 0) -
      (groups["sign"] === "-" ? -zoneMinutes : zoneMinutes);
    const fraction = (groups["fraction"] ?? "").replace(/0+$/u, "");
    return `${timezone === undefined ? "L" : "Z"}${String(minutes)}:${groups["second"] ?? "00"}.${fraction}`;
  },
  decimal: (value): string | null => {
    const decimal = DIGIT.test(value) ? parseDecimal(value) : null;
    return decimal === null
      ? null
      : `${decimal.negative ? "-" : ""}${decimal.integer}.${decimal.fraction}`;
  },
  preserve: (value) => value,
  replace: (value) => value.replaceAll(LINE_WHITESPACE, " "),
} satisfies Record<string, EnumerationKey>;

export type EnumerationSpace = keyof typeof ENUMERATION_KEYS;

export const enumerationKey = (space: EnumerationSpace, value: string): string | null =>
  ENUMERATION_KEYS[space](value);

export const xsdEnumeration = (
  space: EnumerationSpace,
  values: readonly string[],
  examples: readonly string[] = values,
) => {
  const key: EnumerationKey = ENUMERATION_KEYS[space];
  const keys = new Set(values.map(key));
  return Schema.makeFilter(
    (value: string) => {
      const valueKey = key(value);
      return valueKey !== null && keys.has(valueKey);
    },
    {
      arbitraryConstraint:
        examples.length === 0
          ? undefined
          : {
              patterns: [
                {
                  flags: "u",
                  source: `^(?:${examples.map((example) => example.replaceAll(REGEX_SYNTAX, String.raw`\$&`)).join("|")})$`,
                },
              ],
            },
      expected: `one of ${values.map((value) => JSON.stringify(value)).join(", ")}`,
    },
  );
};

const BASE64_VALUES = new Int8Array(128).fill(-1);
for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
  BASE64_VALUES[BASE64_ALPHABET.codePointAt(index) ?? 0] = index;
}

const BASE64_DIGITS = /[A-Za-z0-9+/]*/uy;
const BASE64_PADDING_MODULUS = new Map([
  ["", 1],
  ["=", 4],
  ["==", 16],
]);

export const isBase64Binary = (value: string) => {
  BASE64_DIGITS.lastIndex = 0;
  BASE64_DIGITS.test(value);
  const end = BASE64_DIGITS.lastIndex;
  const modulus = BASE64_PADDING_MODULUS.get(value.slice(end));
  if (modulus !== undefined && value.length % 4 === 0) {
    return (BASE64_VALUES[value.codePointAt(end - 1) ?? 0] ?? 0) % modulus === 0;
  }
  const compact = value.replaceAll(BASE64_WHITESPACE, "");
  const groups = BASE64_LENIENT.exec(compact)?.groups;
  if (groups === undefined) {
    return false;
  }
  const padding = (groups["padding"] ?? "").length;
  const last = BASE64_ALPHABET.indexOf((groups["digits"] ?? "").slice(-1));
  if (compact.length % 4 !== 0 || padding > 2) {
    return false;
  }
  if (padding === 1) {
    return last % 4 === 0;
  }
  return padding === 2 ? last % 16 === 0 : true;
};

export const xsdBase64Binary = Schema.makeFilter((value: string) => isBase64Binary(value), {
  arbitraryConstraint: { patterns: [{ flags: "u", source: BASE64_CANONICAL }] },
  expected: "base64 binary data",
});

type XsdSimple = Schema.Top & {
  readonly DecodingServices: never;
  readonly Encoded: string;
  readonly EncodingServices: never;
};

export const xsdDefault = <S extends XsdSimple>(self: S, value: S["Encoded"]) => {
  const decoded = Schema.decodeSync(self)(value);
  return Schema.Union([self, Schema.Literal("")]).pipe(
    Schema.decodeTo(Schema.toType(self), {
      decode: SchemaGetter.transform((text: S["Type"] | "") => (text === "" ? decoded : text)),
      encode: SchemaGetter.passthroughSubtype(),
    }),
  );
};

export const xsdDefaultKey = <S extends XsdSimple>(self: S, value: S["Encoded"]) => {
  const schema = xsdDefault(self, value);
  return schema.pipe(Schema.withDecodingDefaultKey<typeof schema>(Effect.succeed(value)));
};
