import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import {
  xsdBase64Binary,
  xsdDateRange,
  xsdDecimalRange,
  xsdLength,
} from "../src/xsd-codegen/runtime.ts";

const isBase64 = Schema.is(Schema.String.check(xsdBase64Binary));

const isAmount = Schema.is(
  Schema.String.check(xsdDecimalRange({ maximum: "9999999999999999.99", minimum: "-1.50" })),
);

const isNonNegative = Schema.is(Schema.String.check(xsdDecimalRange({ minimum: "-0.0" })));

const isInvoiceDate = Schema.is(
  Schema.String.check(xsdDateRange({ maximum: "2099-12-31", minimum: "1970-01-01" })),
);

describe("xsdBase64Binary", () => {
  it.each([
    ["", true],
    ["QUJD", true],
    ["QUI=", true],
    ["QQ==", true],
    ["+/+/", true],
    ["QUJDREVG".repeat(1000), true],
    ["QUJ=", false],
    ["QUK=", false],
    ["QR==", false],
    ["Qg==", true],
    ["QB==", false],
    ["QUJ", false],
    ["QUJDR", false],
    ["QUJDRE", false],
    ["Q===", false],
    ["====", false],
    ["=QUJ", false],
    ["QU=I", false],
    ["QUI=QUJD", false],
    ["QQ==QUJD", false],
    ["QUJD=", false],
    ["QUJ-", false],
    ["QUJ_", false],
    ["QUJé", false],
    ["QUJ\u{1F600}", false],
  ])("checks the canonical form %j", (value, expected) => {
    expect(isBase64(value)).toBe(expected);
  });

  it.each([
    [" QUJD", true],
    ["QUJD\n", true],
    ["QUJD\r\nREVG", true],
    ["Q U J D", true],
    ["\tQUI=", true],
    ["QUI =", true],
    ["Q Q = =", true],
    ["QQ=\n=", true],
    ["Q R = =", false],
    ["QU J", false],
    ["QUJD\fREVG", false],
    ["QUJD\u00A0", false],
  ])("checks the value %j with whitespace", (value, expected) => {
    expect(isBase64(value)).toBe(expected);
  });
});

const hasTwoCharacters = Schema.is(
  Schema.String.check(xsdLength({ collapse: false, maximum: 2, minimum: 2 })),
);

const hasTwoCollapsedCharacters = Schema.is(
  Schema.String.check(xsdLength({ collapse: true, maximum: 2, minimum: 2 })),
);

describe("xsdLength", () => {
  it.each([
    ["ab", true],
    ["a", false],
    ["abc", false],
    ["éà", true],
    ["\u4E2D\uFFFD", true],
    ["\u{1F600}", false],
    ["\u{1F600}\u{1F600}", true],
    ["a\u{10FFFF}", true],
    ["\u{1F600}\u{1F600}a", false],
    ["\uD800", false],
    ["\uD800\uD800", true],
    ["\uDC00\uD800", true],
    ["\uDE00\uD83D", true],
    ["a\uDC00", true],
    ["\uD83D\uD83D\uDE00", true],
    ["\uD83D\uDE00\uDE00", true],
    ["\uDE00\uD83D\uDE00\uD83D", false],
  ])("counts %j in code points", (value, expected) => {
    expect(hasTwoCharacters(value)).toBe(expected);
  });

  it.each([
    ["  a \t\n b  ", false],
    [" a\t\n", false],
    ["\t\u{1F600}\u{1F600} ", true],
    [" \u{1F600} \u{1F600} ", false],
    [" \u{1F600}   ", false],
    ["\r\na \r\n", false],
    ["é ", false],
    [" ab\r\n", true],
  ])("counts %j after collapsing the whitespace", (value, expected) => {
    expect(hasTwoCollapsedCharacters(value)).toBe(expected);
  });
});

describe("xsdDecimalRange", () => {
  it.each([
    ["-1.50", true],
    ["-1.5", true],
    ["-001.500000", true],
    ["-1.5000000000000000000000000001", false],
    ["-1.51", false],
    ["-2", false],
    ["-1.49", true],
    ["9999999999999999.99", true],
    ["09999999999999999.990", true],
    ["9999999999999999.9900000000000000000000000001", false],
    ["10000000000000000", false],
    ["99999999999999999999999999999", false],
    ["0", true],
    ["-0", true],
    ["+.5", true],
    ["12.", true],
    ["\t003.400 \r", true],
    ["1e3", false],
  ])("checks %j against -1.50 and 9999999999999999.99", (value, expected) => {
    expect(isAmount(value)).toBe(expected);
  });

  it.each([
    ["0", true],
    ["-0", true],
    ["-0.000", true],
    ["+000.0", true],
    ["-0.0000000000000000000001", false],
    ["0.0000000000000000000001", true],
  ])("treats %j against a minimum of -0.0 as zero", (value, expected) => {
    expect(isNonNegative(value)).toBe(expected);
  });

  it.each([
    ["100.00", true],
    ["+100.00", true],
    ["100.0000000000000", true],
    ["99.999999999999", true],
    ["100.00000000001", false],
    ["100.000000000001", false],
    ["100.0000000000001", false],
    ["-100.01", true],
    ["1e2", false],
  ])("checks %j against a maximum of 100.00 on either side of 15 characters", (value, expected) => {
    const isRate = Schema.is(Schema.String.check(xsdDecimalRange({ maximum: "100.00" })));

    expect(isRate(value)).toBe(expected);
  });

  it.each([
    ["1.0000000000001", true],
    ["1.0000000000002", true],
    ["1.0000000000000", false],
    ["1.00000000000009", false],
    ["1.00000000000011", true],
    ["999999999999999", true],
    ["1000000000000000", false],
    ["999999999999999.1", false],
  ])("checks %j against 15-character bounds", (value, expected) => {
    const isInRange = Schema.is(
      Schema.String.check(
        xsdDecimalRange({ maximum: "999999999999999", minimum: "1.0000000000001" }),
      ),
    );

    expect(isInRange(value)).toBe(expected);
  });

  it.each([
    ["12.5", true],
    ["12.500", true],
    ["+12.5", true],
    ["12.49999999999", false],
    ["12.50000000001", false],
    ["12.5000000000000000001", false],
  ])("checks %j against equal bounds written differently", (value, expected) => {
    const isExactly = Schema.is(
      Schema.String.check(xsdDecimalRange({ maximum: "12.5", minimum: "12.50" })),
    );

    expect(isExactly(value)).toBe(expected);
  });

  it("rejects every value when a bound is not a decimal", () => {
    const isInBrokenRange = Schema.is(Schema.String.check(xsdDecimalRange({ minimum: "one" })));

    expect(isInBrokenRange("1")).toBe(false);
  });
});

describe("xsdDateRange", () => {
  it.each([
    ["1970-01-01", true],
    ["1969-12-31", false],
    ["2099-12-31", true],
    ["2100-01-01", false],
    ["2024-02-29", true],
    ["2023-02-29", false],
    ["1970-01-02Z", false],
    ["1970-01-03Z", true],
    ["1970-01-03+02:00", true],
    ["2099-12-29-05:00", true],
    ["2099-12-30Z", false],
    ["not a date", false],
  ])("checks %j against 1970-01-01 and 2099-12-31", (value, expected) => {
    expect(isInvoiceDate(value)).toBe(expected);
  });

  it("rejects every value when a bound is not a date", () => {
    const isInBrokenRange = Schema.is(Schema.String.check(xsdDateRange({ maximum: "2024-02-30" })));

    expect(isInBrokenRange("2024-01-01")).toBe(false);
  });
});
