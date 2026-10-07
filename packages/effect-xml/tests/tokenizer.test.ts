import { describe, expect, it } from "@effect/vitest";
import { readFileSync } from "node:fs";
import { Effect, Result } from "effect";
import { XmlCData, XmlDocument, XmlElement, XmlText } from "libxml2-wasm";
import type { XmlTreeNode } from "libxml2-wasm";
import { startsWith } from "./fixtures/messages.ts";
import { tokenize } from "../src/tokenizer.ts";
import type { TokenHandler, TokenizeOptions } from "../src/types.ts";

type Event =
  | readonly ["attribute", string, string, number]
  | readonly ["close"]
  | readonly ["openEnd"]
  | readonly ["openStart", string, number]
  | readonly ["text", string, number];

const recordingHandler = (events: Event[], stopAfter = Number.POSITIVE_INFINITY) => {
  const push = (event: Event) => {
    events.push(event);
    return events.length < stopAfter;
  };
  const handler: TokenHandler = {
    attribute: (qname, value, offset) => push(["attribute", qname, value, offset]),
    close: () => push(["close"]),
    openEnd: () => push(["openEnd"]),
    openStart: (qname, offset) => push(["openStart", qname, offset]),
    text: (value, offset) => push(["text", value, offset]),
  };
  return handler;
};

const record = (xml: string, options?: Partial<TokenizeOptions>) => {
  const events: Event[] = [];
  return Effect.fromResult(tokenize(xml, recordingHandler(events), options)).pipe(
    Effect.map(() => events),
  );
};

const texts = (xml: string, options?: Partial<TokenizeOptions>) =>
  record(xml, options).pipe(
    Effect.map((events) => events.flatMap((event) => (event[0] === "text" ? [event[1]] : []))),
  );

const keptTexts = (xml: string) => {
  const events: Event[] = [];
  return Effect.fromResult(
    tokenize(xml, { ...recordingHandler(events), keepWhitespace: () => true }),
  ).pipe(Effect.map(() => events.flatMap((event) => (event[0] === "text" ? [event[1]] : []))));
};

const attributes = (xml: string) =>
  record(xml).pipe(
    Effect.map((events) =>
      events.flatMap((event) => (event[0] === "attribute" ? [[event[1], event[2]]] : [])),
    ),
  );

const parseError = (xml: string, options?: Partial<TokenizeOptions>) =>
  Effect.flip(Effect.fromResult(tokenize(xml, recordingHandler([]), options)));

describe("tokenize events", () => {
  it.effect("emits open, attribute, text and close events with source offsets", () =>
    Effect.gen(function* emitsEvents() {
      const events = yield* record(`<a x="1"><b>hi</b></a>`);

      expect(events).toStrictEqual([
        ["openStart", "a", 0],
        ["attribute", "x", "1", 3],
        ["openEnd"],
        ["openStart", "b", 9],
        ["openEnd"],
        ["text", "hi", 12],
        ["close"],
        ["close"],
      ]);
    }),
  );

  it.effect("reports an empty-element tag as openEnd followed by close", () =>
    Effect.gen(function* emptyElement() {
      const events = yield* record(`<a><b y='2'/></a>`);

      expect(events).toStrictEqual([
        ["openStart", "a", 0],
        ["openEnd"],
        ["openStart", "b", 3],
        ["attribute", "y", "2", 6],
        ["openEnd"],
        ["close"],
        ["close"],
      ]);
    }),
  );

  it.effect("keeps namespace prefixes in element and attribute names", () =>
    Effect.gen(function* rawQnames() {
      const events = yield* record(`<p:Fattura xmlns:p="urn:x" p:v="1"></p:Fattura>`);

      expect(events).toContainEqual(["openStart", "p:Fattura", 0]);
      expect(events).toContainEqual(["attribute", "xmlns:p", "urn:x", 11]);
      expect(events).toContainEqual(["attribute", "p:v", "1", 27]);
    }),
  );

  it.effect("accepts whitespace around '=' and before '>' in tags", () =>
    Effect.gen(function* tagWhitespace() {
      const values = yield* attributes(`<a  x = "1"\n\ty='2' ></a >`);

      expect(values).toStrictEqual([
        ["x", "1"],
        ["y", "2"],
      ]);
    }),
  );

  it.effect("keeps the other quote character inside an attribute value", () =>
    Effect.gen(function* quotesInValues() {
      const values = yield* attributes(`<a x="it's" y='say "hi"'/>`);

      expect(values).toStrictEqual([
        ["x", "it's"],
        ["y", 'say "hi"'],
      ]);
    }),
  );

  it.effect(
    "ignores a leading BOM, the XML declaration, processing instructions and comments",
    () =>
      Effect.gen(function* ignoredMarkup() {
        const events = yield* record(
          `\uFEFF<?xml version="1.0"?>\n<!-- c --><?pi data?><a><!-- <b> --><?x y?></a><!-- end -->`,
        );

        expect(events).toStrictEqual([["openStart", "a", 44], ["openEnd"], ["close"]]);
      }),
  );

  it.effect("emits CDATA content as text without decoding it", () =>
    Effect.gen(function* cdata() {
      const values = yield* texts(`<a><![CDATA[<b>&amp;</b>]]></a>`);

      expect(values).toStrictEqual(["<b>&amp;</b>"]);
    }),
  );

  it.effect("splits text around CDATA into separate text events", () =>
    Effect.gen(function* splitText() {
      const values = yield* texts(`<a>x &lt; <![CDATA[y]]> z</a>`);

      expect(values).toStrictEqual(["x < ", "y", " z"]);
    }),
  );

  it.effect("returns true when the whole document is tokenized", () =>
    Effect.gen(function* completes() {
      const completed = yield* Effect.fromResult(tokenize("<a>x</a>", recordingHandler([])));

      expect(completed).toBe(true);
    }),
  );

  it.effect("stops and returns false as soon as the handler returns false", () =>
    Effect.gen(function* stops() {
      const events: Event[] = [];

      const completed = yield* Effect.fromResult(
        tokenize("<a><b>x</b><c/></a>", recordingHandler(events, 3)),
      );

      expect(completed).toBe(false);
      expect(events).toStrictEqual([["openStart", "a", 0], ["openEnd"], ["openStart", "b", 3]]);
    }),
  );
});

describe("tokenize whitespace", () => {
  it.effect("skips whitespace-only text by default", () =>
    Effect.gen(function* skipsWhitespace() {
      const values = yield* texts("<a>\n  <b> x </b>\n</a>");

      expect(values).toStrictEqual([" x "]);
    }),
  );

  it.effect("emits whitespace-only text inside the root when the handler keeps whitespace", () =>
    Effect.gen(function* keepsWhitespace() {
      const values = yield* keptTexts("\n<a>\n  <b> x </b>\n</a>\n");

      expect(values).toStrictEqual(["\n  ", " x ", "\n"]);
    }),
  );

  it.effect("normalizes CRLF and CR line endings in text to LF", () =>
    Effect.gen(function* textLineEndings() {
      const values = yield* texts("<a>1\r\n2\r3\n4<![CDATA[5\r\n6]]></a>");

      expect(values).toStrictEqual(["1\n2\n3\n4", "5\n6"]);
    }),
  );

  it.effect("decodes entities and line endings in text longer than 128 characters", () =>
    Effect.gen(function* longText() {
      const plain = "p".repeat(200);
      const encoded = `${"a".repeat(150)}&amp;${"b".repeat(150)}`;
      const carriageReturn = `${"c".repeat(150)}\r${"d".repeat(150)}`;

      const values = yield* texts(
        `<r><x>${plain}</x><y>${encoded}</y><z>${carriageReturn}</z></r>`,
      );

      expect(values).toStrictEqual([
        plain,
        `${"a".repeat(150)}&${"b".repeat(150)}`,
        `${"c".repeat(150)}\n${"d".repeat(150)}`,
      ]);
    }),
  );

  it.effect.each([1023, 1024, 1025, 1026])(
    "decodes an entity and CRLF at both ends of a %i-character text",
    (length) =>
      Effect.gen(function* thresholdText() {
        const middle = "m".repeat(length - 14);
        const values = yield* texts(`<a>&lt;\r\n${middle}\r&amp;\r\n</a>`);

        expect(values).toStrictEqual([`<\n${middle}\n&\n`]);
      }),
  );

  it.effect("normalizes every CRLF of a long wrapped text", () =>
    Effect.gen(function* wrappedText() {
      const lines = Array.from({ length: 40 }, (_, index) => String(index).padEnd(76, "A"));

      const values = yield* texts(`<a>${lines.join("\r\n")}\r\n</a>`);

      expect(values).toStrictEqual([`${lines.join("\n")}\n`]);
    }),
  );

  it.effect("normalizes a CR that ends a long text before CDATA that starts with LF", () =>
    Effect.gen(function* splitLineEnding() {
      const long = "z".repeat(2000);

      const values = yield* texts(`<a>${long}\r<![CDATA[\n${long}\r]]></a>`);

      expect(values).toStrictEqual([`${long}\n`, `\n${long}\n`]);
    }),
  );

  it.effect("normalizes CR and CRLF but keeps entities in long CDATA", () =>
    Effect.gen(function* longCdata() {
      const long = "c".repeat(1500);

      const values = yield* texts(`<a><![CDATA[${long}\r\n${long}\r&amp;\t]]></a>`);

      expect(values).toStrictEqual([`${long}\n${long}\n&amp;\t`]);
    }),
  );

  it.effect("normalizes whitespace and decodes references in a long attribute value", () =>
    Effect.gen(function* longAttribute() {
      const long = "v".repeat(1500);

      const values = yield* attributes(`<a x="${long}\t${long}&#10;\r\n\n&amp;"/>`);

      expect(values).toStrictEqual([["x", `${long} ${long}\n  &`]]);
    }),
  );

  it.effect("normalizes CR in whitespace-only text when the handler keeps whitespace", () =>
    Effect.gen(function* whitespaceCarriageReturn() {
      const values = yield* keptTexts("<a>\r\n  <b/>\r</a>");

      expect(values).toStrictEqual(["\n  ", "\n"]);
    }),
  );

  it.effect("normalizes tab, LF, CR and CRLF in attribute values to one space each", () =>
    Effect.gen(function* attributeWhitespace() {
      const values = yield* attributes(`<a x="1\t2\n3\r4\r\n5"/>`);

      expect(values).toStrictEqual([["x", "1 2 3 4 5"]]);
    }),
  );

  it.effect("keeps whitespace written as character references in attribute values", () =>
    Effect.gen(function* attributeReferences() {
      const values = yield* attributes(`<a x="1&#10;2&#9;3&#13;4"/>`);

      expect(values).toStrictEqual([["x", "1\n2\t3\r4"]]);
    }),
  );
});

describe("tokenize entities", () => {
  it.effect("decodes the five predefined entities in text", () =>
    Effect.gen(function* predefinedText() {
      const values = yield* texts("<a>&lt;&gt;&amp;&quot;&apos;</a>");

      expect(values).toStrictEqual([`<>&"'`]);
    }),
  );

  it.effect("decodes predefined entities and character references in attribute values", () =>
    Effect.gen(function* attributeEntities() {
      const values = yield* attributes(`<a x="&lt;&amp;&quot;&#65;&#x42;"/>`);

      expect(values).toStrictEqual([["x", `<&"AB`]]);
    }),
  );

  it.effect("decodes decimal and hexadecimal character references, including astral ones", () =>
    Effect.gen(function* characterReferences() {
      const values = yield* texts("<a>&#65;&#x42;&#xe8;&#128512;&#x1F600;</a>");

      expect(values).toStrictEqual(["ABè😀😀"]);
    }),
  );

  it.effect("fails with the position of an unknown entity", () =>
    Effect.gen(function* unknownEntity() {
      const error = yield* parseError("<a>\nx &nbsp; y</a>");

      expect(error.position).toStrictEqual({ column: 3, line: 2, offset: 6 });
    }),
  );

  it.effect.each([
    ["text", (value: string) => `<a>${value}</a>`, 3],
    ["an attribute value", (value: string) => `<a x="${value}"/>`, 6],
  ] as const)("fails with the exact position of an unknown entity in long %s", ([, wrap, start]) =>
    Effect.gen(function* longUnknownEntity() {
      const head = `${"x".repeat(1500)}&amp;\r\n${"y".repeat(10)}`;

      const error = yield* parseError(wrap(`${head}&nbsp;${"z".repeat(1500)}`));

      expect(error).toMatchObject({
        message: startsWith("Unknown or malformed entity reference"),
        position: { column: 11, line: 2, offset: start + head.length },
      });
    }),
  );

  it.effect("fails on an entity reference without a semicolon", () =>
    Effect.gen(function* missingSemicolon() {
      const error = yield* parseError("<a>fish &amp chips</a>");

      expect(error.position.offset).toBe(8);
    }),
  );

  it.effect("fails on an unknown entity inside an attribute value", () =>
    Effect.gen(function* attributeEntity() {
      const error = yield* parseError(`<a x="&copy;"/>`);

      expect(error.position.offset).toBe(6);
    }),
  );

  it.effect("fails on character references that are not XML characters", () =>
    Effect.gen(function* invalidCharacterReferences() {
      const nul = yield* parseError("<a>&#0;</a>");
      const beyondUnicode = yield* parseError("<a>&#x110000;</a>");
      const emptyHex = yield* parseError("<a>&#x;</a>");

      expect(nul.position.offset).toBe(3);
      expect(beyondUnicode.position.offset).toBe(3);
      expect(emptyHex.position.offset).toBe(3);
    }),
  );
});

describe("tokenize characters", () => {
  const longText = "x".repeat(200);

  it.effect.each([
    ["a form feed in short text", "<a>ab\fc</a>", 5],
    ["a NUL in short text", "<a>\u0000</a>", 3],
    ["U+FFFE in short text", "<a>b\uFFFE</a>", 4],
    ["U+FFFF in short text", "<a>\uFFFF</a>", 3],
    ["a control character next to an entity", "<a>&amp;\u0001</a>", 8],
    ["a control character in long text", `<a>${longText}\u001F</a>`, 203],
    ["U+FFFF in long text", `<a>${longText}\uFFFF</a>`, 203],
    ["a control character in long text with a CR", `<a>${longText}\r\u0008</a>`, 204],
    [
      "a control character after a CRLF in a text longer than 1024 characters",
      `<a>${longText.repeat(6)}&amp;\r\n\u0008</a>`,
      1210,
    ],
    [
      "a control character after LF in an attribute longer than 1024 characters",
      `<a x="${longText.repeat(6)}\n\u0002"/>`,
      1207,
    ],
    [
      "a control character after CR in CDATA longer than 1024 characters",
      `<a><![CDATA[${longText.repeat(6)}\r\u0003]]></a>`,
      1213,
    ],
    ["a control character in CDATA", "<a><![CDATA[x\u000B]]></a>", 13],
    ["a control character in an attribute value", '<a x="1\u0007"/>', 7],
    ["U+FFFE in an attribute value", '<a x="\uFFFE"/>', 6],
    ["a lone high surrogate in short text", "<a>b\uD83Dc</a>", 4],
    ["a lone high surrogate at the end of short text", "<a>b\uD83D</a>", 4],
    ["a lone low surrogate in short text", "<a>\uDE00</a>", 3],
    ["a low surrogate after a valid pair", "<a>😀\uDE00</a>", 5],
    ["a lone high surrogate before an entity", "<a>\uDBFF&amp;</a>", 3],
    ["a lone high surrogate in medium text", `<a>${longText}\uD800x</a>`, 203],
    ["a lone low surrogate in medium text with an entity", `<a>&amp;${longText}\uDFFF</a>`, 208],
    [
      "a lone low surrogate after a pair in text longer than 1024 characters",
      `<a>${longText.repeat(6)}&amp;😀\uDC00</a>`,
      1210,
    ],
    ["a lone high surrogate in CDATA", "<a><![CDATA[x\uD800]]></a>", 13],
    ["a lone low surrogate in long CDATA with a CR", `<a><![CDATA[\r${longText}\uDC00]]></a>`, 213],
    ["a lone high surrogate in an attribute value", '<a x="1\uD83D"/>', 7],
    [
      "a lone low surrogate in an attribute longer than 1024 characters",
      `<a x="${longText.repeat(6)}\t\uDE00"/>`,
      1207,
    ],
  ] as const)("fails on %s with its position", ([, xml, offset]) =>
    Effect.gen(function* nonCharacter() {
      const error = yield* parseError(xml);

      expect(error).toMatchObject({
        message: startsWith("Character not allowed in XML 1.0"),
        position: { offset },
      });
    }),
  );

  it.effect("accepts tab, LF and CR in short text, long text and CDATA", () =>
    Effect.gen(function* allowedWhitespace() {
      const values = yield* texts(
        `<a><b>x\ty\nz</b><c>${longText}\t\n</c><d><![CDATA[p\tq]]></d></a>`,
      );

      expect(values).toStrictEqual(["x\ty\nz", `${longText}\t\n`, "p\tq"]);
    }),
  );

  it.effect("accepts characters outside the BMP and the last BMP character before U+FFFE", () =>
    Effect.gen(function* allowedCharacters() {
      const values = yield* texts("<a>\uFFFD😀</a>");

      expect(values).toStrictEqual(["\uFFFD😀"]);
    }),
  );

  it.effect.each([130, 1100])(
    "accepts surrogate pairs in short, %i-character and CDATA text and in attribute values",
    (length) =>
      Effect.gen(function* surrogatePairs() {
        const long = `😀${"x".repeat(length)}\uDBFF\uDFFF`;

        const xml = `<a v="𐍈" w="${long}&amp;"><b>𐍈&amp;</b><c>${long}\r</c><![CDATA[😀\r${long}]]></a>`;

        expect(yield* attributes(xml)).toStrictEqual([
          ["v", "𐍈"],
          ["w", `${long}&`],
        ]);
        expect(yield* texts(xml)).toStrictEqual(["𐍈&", `${long}\n`, `😀\n${long}`]);
      }),
  );
});

describe("tokenize security", () => {
  it.effect("rejects a DOCTYPE declaration", () =>
    Effect.gen(function* doctype() {
      const error = yield* parseError(`<?xml version="1.0"?>\n<!DOCTYPE a [<!ENTITY x "y">]><a/>`);

      expect(error.message).toContain("DOCTYPE");
      expect(error.position).toStrictEqual({ column: 1, line: 2, offset: 22 });
    }),
  );

  it.effect("rejects an ENTITY declaration", () =>
    Effect.gen(function* entityDeclaration() {
      const error = yield* parseError(`<!ENTITY x "y"><a/>`);

      expect(error.message).toContain("ENTITY");
      expect(error.position.offset).toBe(0);
    }),
  );
});

describe("tokenize well-formedness", () => {
  it.effect("fails on a closing tag that does not match the open element", () =>
    Effect.gen(function* mismatchedClose() {
      const error = yield* parseError("<a>\n  <b></c>\n</a>");

      expect(error.message).toContain("</c>");
      expect(error.position).toStrictEqual({ column: 6, line: 2, offset: 9 });
    }),
  );

  it.effect("fails on a closing tag whose name only starts with the open element name", () =>
    Effect.gen(function* prefixClose() {
      const error = yield* parseError("<a></ab>");

      expect(error.position.offset).toBe(3);
    }),
  );

  it.effect("fails at the end of the document when elements are still open", () =>
    Effect.gen(function* unclosed() {
      const error = yield* parseError("<a><b>x</b>");

      expect(error.message).toContain("<a>");
      expect(error.position.offset).toBe(11);
    }),
  );

  it.effect("fails on an empty document", () =>
    Effect.gen(function* emptyDocument() {
      const error = yield* parseError("  ");

      expect(error.position.offset).toBe(2);
    }),
  );

  it.effect("fails on a second root element", () =>
    Effect.gen(function* secondRoot() {
      const error = yield* parseError("<a/>\n<b/>");

      expect(error.position).toStrictEqual({ column: 1, line: 2, offset: 5 });
    }),
  );

  it.effect("fails on text before the root element", () =>
    Effect.gen(function* textBeforeRoot() {
      const error = yield* parseError("  hi<a/>");

      expect(error.position.offset).toBe(2);
    }),
  );

  it.effect("fails on text after the root element", () =>
    Effect.gen(function* textAfterRoot() {
      const error = yield* parseError("<a/>\n oops");

      expect(error.position).toStrictEqual({ column: 2, line: 2, offset: 6 });
    }),
  );

  it.effect("fails on a duplicate attribute", () =>
    Effect.gen(function* duplicateAttribute() {
      const error = yield* parseError(`<a x="1" y="2" x="3"/>`);

      expect(error.message).toContain("x");
      expect(error.position.offset).toBe(15);
    }),
  );

  it.effect("fails on a duplicate attribute among many attributes", () =>
    Effect.gen(function* duplicateAmongMany() {
      const many = Array.from({ length: 40 }, (_, index) => `a${String(index)}="v"`).join(" ");

      const error = yield* parseError(`<a ${many} a35="w"/>`);

      expect(error.message).toContain("a35");
    }),
  );

  it.effect("fails on '<' inside an attribute value", () =>
    Effect.gen(function* ltInAttribute() {
      const error = yield* parseError(`<a x="1<2"/>`);

      expect(error.position.offset).toBe(7);
    }),
  );

  it.effect("fails on '<' in a long attribute value before an earlier unknown entity", () =>
    Effect.gen(function* ltInLongAttribute() {
      const long = "v".repeat(1500);

      const error = yield* parseError(`<a x="${long}&nbsp;${long}<"/>`);

      expect(error).toMatchObject({
        message: startsWith("'<' is not allowed in attribute values"),
        position: { offset: 3006 + 6 },
      });
    }),
  );

  it.effect("fails on an attribute without whitespace before it", () =>
    Effect.gen(function* missingWhitespace() {
      const error = yield* parseError(`<a x="1"y="2"/>`);

      expect(error.position.offset).toBe(8);
    }),
  );

  it.effect("fails on an unquoted attribute value", () =>
    Effect.gen(function* unquotedValue() {
      const error = yield* parseError(`<a x=1/>`);

      expect(error.position.offset).toBe(5);
    }),
  );

  it.effect("fails on CDATA outside the root element", () =>
    Effect.gen(function* cdataOutsideRoot() {
      const error = yield* parseError("<a/><![CDATA[x]]>");

      expect(error.position.offset).toBe(4);
    }),
  );

  it.effect("fails on an unterminated comment", () =>
    Effect.gen(function* unterminatedComment() {
      const error = yield* parseError(`<a><!-- x</a>`);

      expect(error.position.offset).toBe(3);
    }),
  );

  it.effect("fails on '--' inside a comment", () =>
    Effect.gen(function* doubleHyphenInComment() {
      const error = yield* parseError(`<a><!-- x -- y --></a>`);

      expect(error).toMatchObject({
        message: startsWith("'--' is not allowed inside a comment"),
        position: { offset: 10 },
      });
    }),
  );

  it.effect("fails on a comment that ends with '-'", () =>
    Effect.gen(function* hyphenBeforeCommentEnd() {
      const error = yield* parseError(`<a><!-- x ---></a>`);

      expect(error.position.offset).toBe(10);
    }),
  );

  it.effect("accepts an empty comment and single hyphens inside a comment", () =>
    Effect.gen(function* validComments() {
      const values = yield* texts(`<a><!----><!-- a-b - c -->t</a>`);

      expect(values).toStrictEqual(["t"]);
    }),
  );

  it.effect("fails on an XML declaration that is not at the start", () =>
    Effect.gen(function* lateDeclaration() {
      const error = yield* parseError(`\n<?xml version="1.0"?><a/>`);

      expect(error.position.offset).toBe(1);
    }),
  );

  it.effect.each([
    ["short text", `<a>Roma]]>Centro</a>`, 7],
    ["long text", `<a>${"x".repeat(200)}]]>y</a>`, 203],
    ["text after a CDATA section and an attribute value", `<a b="]]>"><![CDATA[q]]>t]]></a>`, 25],
  ] as const)("fails on ']]>' in %s", ([, xml, offset]) =>
    Effect.gen(function* cdataEndInText() {
      const error = yield* parseError(xml);

      expect(error).toMatchObject({
        message: startsWith("']]>' is not allowed in text"),
        position: { offset },
      });
    }),
  );

  it.effect("accepts ']]>' in CDATA and attribute values and ']]' or '>' alone in text", () =>
    Effect.gen(function* cdataEndElsewhere() {
      const events = yield* record(`<a b="]]>"><![CDATA[x]]>]]<![CDATA[y]]>]] >&gt;</a>`);

      expect(events).toContainEqual(["attribute", "b", "]]>", 3]);
      expect(events.flatMap((event) => (event[0] === "text" ? [event[1]] : []))).toStrictEqual([
        "x",
        "]]",
        "y",
        "]] >>",
      ]);
    }),
  );

  it.effect.each([
    `<?xml?><a/>`,
    `<?xml bogus?><a/>`,
    `<?xml encoding="UTF-8"?><a/>`,
    `<?xml version="2.0"?><a/>`,
    `<?xml version="1.0" standalone="yes" encoding="UTF-8"?><a/>`,
    `<?xml version="1.0"encoding="UTF-8"?><a/>`,
  ])("fails on the malformed XML declaration %s", (xml) =>
    Effect.gen(function* malformedDeclaration() {
      const error = yield* parseError(xml);

      expect(error).toMatchObject({
        message: startsWith(
          'Malformed XML declaration: expected version="1.x", then optional encoding and standalone',
        ),
        position: { offset: 0 },
      });
    }),
  );

  it.effect.each([
    `<?xml version="1.0"?><a/>`,
    `<?xml version='1.0' encoding='UTF-8'?><a/>`,
    `\uFEFF<?xml version = "1.0" encoding="ISO-8859-1" standalone="no" ?><a/>`,
    `<?xml\r\n  version="1.1"\tstandalone='yes'?><a/>`,
  ])("accepts the XML declaration %s", (xml) =>
    Effect.gen(function* validDeclaration() {
      expect(yield* record(xml)).toContainEqual(["openStart", "a", xml.indexOf("<a")]);
    }),
  );

  it.effect("accepts nesting up to maxDepth", () =>
    Effect.gen(function* withinDepth() {
      const events = yield* record("<a><b><c/></b></a>", { maxDepth: 3 });

      expect(events).toContainEqual(["openStart", "c", 6]);
    }),
  );

  it.effect("fails when nesting exceeds maxDepth", () =>
    Effect.gen(function* beyondDepth() {
      const error = yield* parseError("<a><b><c/></b></a>", { maxDepth: 2 });

      expect(error.position.offset).toBe(6);
    }),
  );

  it.effect("limits nesting to 256 elements by default", () =>
    Effect.gen(function* defaultDepth() {
      const accepted = yield* Effect.fromResult(
        tokenize(`${"<a>".repeat(256)}${"</a>".repeat(256)}`, recordingHandler([])),
      );
      const error = yield* parseError(`${"<a>".repeat(257)}${"</a>".repeat(257)}`);

      expect(accepted).toBe(true);
      expect(error.position.offset).toBe(768);
    }),
  );
});

describe("tokenize names and the end of the document", () => {
  it.effect("reads names with ASCII name characters, non-ASCII letters and astral characters", () =>
    Effect.gen(function* names() {
      const events = yield* record(`<_a-b.c:9é😀 x-y.z_0:1\u0080="v"/>`);

      expect(events).toStrictEqual([
        ["openStart", "_a-b.c:9é😀", 0],
        ["attribute", "x-y.z_0:1\u0080", "v", 13],
        ["openEnd"],
        ["close"],
      ]);
    }),
  );

  it.effect("accepts a name that starts with a surrogate pair", () =>
    Effect.gen(function* astralStart() {
      const events = yield* record(`<😀a 𐍈="v"/>`);

      expect(events).toStrictEqual([
        ["openStart", "😀a", 0],
        ["attribute", "𐍈", "v", 5],
        ["openEnd"],
        ["close"],
      ]);
    }),
  );

  it.effect.each([
    ["a lone high surrogate in an element name", "<ab\uD800/>", 3],
    ["a high surrogate before a non-surrogate in an element name", "<a\uD83Dx/>", 2],
    ["a lone low surrogate at the start of an element name", "<\uDC00/>", 1],
    ["U+FFFE in an element name", "<a\uFFFE/>", 2],
    ["U+FFFF at the start of an attribute name", '<a \uFFFF="1"/>', 3],
    ["a lone low surrogate in an attribute name", '<a b\uDC00="1"/>', 4],
    ["U+FFFF in a closing tag name", "<a></a\uFFFF>", 6],
    ["U+FFFE in a processing instruction target", "<?pi\uFFFE?><a/>", 4],
  ] as const)("fails on %s with its position", ([, xml, offset]) =>
    Effect.gen(function* invalidNameCharacter() {
      const error = yield* parseError(xml);

      expect(error).toMatchObject({
        message: startsWith("Character not allowed in XML 1.0"),
        position: { offset },
      });
    }),
  );

  it.effect.each(["@", "[", "`", "{", "\u007F", ",", ";"])(
    "ends a name at %j, just outside the ASCII name ranges",
    (char) =>
      Effect.gen(function* nameBoundary() {
        const error = yield* parseError(`<ab${char}/>`);

        expect(error).toMatchObject({
          message: startsWith("Unexpected character in start tag <ab>"),
          position: { offset: 3 },
        });
      }),
  );

  it.effect.each([
    ["after '<'", "<", "Invalid element name", 1],
    ["inside a start tag name", "<ab", "Unterminated start tag <ab>", 0],
    ["after whitespace in a start tag", "<a \t\r\n", "Unterminated start tag <a>", 0],
    ["inside an attribute name", "<a b", "Expected '=' after attribute b", 4],
    ["after '=' and whitespace", "<a b= ", "Expected a quoted value for attribute b", 6],
    ["inside a closing tag", "<a></a", "Malformed closing tag </a>", 3],
    ["after whitespace in a closing tag", "<a></a \n", "Malformed closing tag </a>", 3],
    [
      "after '/' in an empty-element tag",
      "<a/",
      "Expected '>' after '/' in an empty-element tag",
      2,
    ],
  ] as const)("fails when the document ends %s", ([, xml, message, offset]) =>
    Effect.gen(function* documentEnd() {
      const error = yield* parseError(xml);

      expect(error).toMatchObject({ message: startsWith(message), position: { offset } });
    }),
  );
});

type Token =
  | readonly ["close", string]
  | readonly ["open", string, readonly string[]]
  | readonly ["text", string];

const qualified = (prefix: string, name: string) => (prefix === "" ? name : `${prefix}:${name}`);

const libxml2Tokens = (node: XmlTreeNode | null): Token[] => {
  if (node === null) {
    return [];
  }
  const rest = libxml2Tokens(node.next);
  if (node instanceof XmlElement) {
    const declared = [
      ...Object.entries(node.nsDeclarations).map(
        ([prefix, uri]) => `${prefix === "" ? "xmlns" : `xmlns:${prefix}`}=${uri}`,
      ),
      ...node.attrs.map(
        (attribute) => `${qualified(attribute.prefix, attribute.name)}=${attribute.content}`,
      ),
    ].toSorted();
    const name = qualified(node.prefix, node.name);
    return [["open", name, declared], ...libxml2Tokens(node.firstChild), ["close", name], ...rest];
  }
  if ((node instanceof XmlText || node instanceof XmlCData) && node.content.trim() !== "") {
    return [["text", node.content], ...rest];
  }
  return rest;
};

describe("tokenize on FatturaPA fixtures", () => {
  for (const slug of ["1-linea", "20-linee"]) {
    it.effect(`matches the libxml2 element, attribute and text sequence for ${slug}`, () =>
      Effect.gen(function* matchesLibxml2() {
        const xml = readFileSync(new URL(`fixtures/fattura-${slug}.xml`, import.meta.url), "utf-8");
        const document = XmlDocument.fromString(xml);
        const expected = libxml2Tokens(document.root);
        document.dispose();

        const actual: Token[] = [];
        const open: string[] = [];
        const pending: string[] = [];

        yield* Effect.fromResult(
          tokenize(xml, {
            attribute: (qname, value) => pending.push(`${qname}=${value}`) > 0,
            close: () => actual.push(["close", open.pop() ?? ""]) > 0,
            openEnd: () => {
              const last = actual.at(-1);
              if (last?.[0] === "open") {
                actual[actual.length - 1] = ["open", last[1], pending.toSorted()];
              }
              pending.length = 0;
              return true;
            },
            openStart: (qname) => open.push(qname) > 0 && actual.push(["open", qname, []]) > 0,
            text: (value) => actual.push(["text", value]) > 0,
          }),
        );

        expect(actual).toStrictEqual(expected);
      }),
    );
  }
});

describe("tokenize result type", () => {
  it("returns a failed Result instead of throwing", () => {
    expect(Result.isFailure(tokenize("<a>", recordingHandler([])))).toBe(true);
  });
});
