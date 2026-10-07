import { describe, expect, it } from "@effect/vitest";
import { positionAt } from "../src/characters.ts";

describe("positionAt", () => {
  it("counts lines and columns from 1", () => {
    expect(positionAt("ab\ncd", 4)).toStrictEqual({ column: 2, line: 2, offset: 4 });
  });

  it("treats CRLF as one line break and a lone CR as a line break", () => {
    expect(positionAt("a\r\nb\rc", 5)).toStrictEqual({ column: 1, line: 3, offset: 5 });
  });

  it.each([
    ["between the CR and the LF of a CRLF", "a\r\nb", 2, { column: 3, line: 1, offset: 2 }],
    ["right after a CRLF", "a\r\nb", 3, { column: 1, line: 2, offset: 3 }],
    ["right after a CR that ends the string", "a\r", 2, { column: 1, line: 2, offset: 2 }],
    ["after LF followed by CR", "\n\rx", 2, { column: 1, line: 3, offset: 2 }],
    ["right before the first line break", "ab\ncd", 2, { column: 3, line: 1, offset: 2 }],
    ["before the start, clamped to 0", "a\nb", -3, { column: 1, line: 1, offset: 0 }],
    ["past the end, clamped to the length", "a\r\nbc", 99, { column: 3, line: 2, offset: 5 }],
    ["in an empty string", "", 1, { column: 1, line: 1, offset: 0 }],
  ] as const)("reports the position %s", (_, xml, offset, position) => {
    expect(positionAt(xml, offset)).toStrictEqual(position);
  });

  it("counts every line of a long document with mixed line endings", () => {
    const xml = `${"x\r\n".repeat(5000)}${"y\r".repeat(3000)}${"z\n".repeat(2000)}end`;

    expect(positionAt(xml, xml.length)).toStrictEqual({
      column: 4,
      line: 10_001,
      offset: xml.length,
    });
  });
});
