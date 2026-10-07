/* oxlint-disable unicorn/prefer-code-point -- the checks compare UTF-16 code units */
import type { XmlPosition } from "./errors/xml-position.ts";

const TAB_CODE = 0x09;
const LF_CODE = 0x0a;
const CR_CODE = 0x0d;
const SPACE_CODE = 0x20;
const HIGH_SURROGATE_CODE = 0xd8_00;
const LOW_SURROGATE_CODE = 0xdc_00;
const PRIVATE_USE_CODE = 0xe0_00;
const NON_CHARACTER_CODE = 0xff_fe;
// oxlint-disable-next-line no-control-regex -- control characters excluded from Char
const LOW_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u0012]/gu;
// oxlint-disable-next-line no-control-regex, require-unicode-regexp -- also finds surrogate halves
const HIGH_CONTROLS_AND_SURROGATES = /[\u0013-\u001F\uD800-\uDFFF]/g;
const LINE_BREAKS = /\n|\r(?!\n)/gu;

export const nextIndexOf = (xml: string, search: string, from: number) => {
  const index = xml.indexOf(search, from);
  return index === -1 ? xml.length : index;
};

export const characterWidth = (xml: string, index: number) => {
  const code = xml.charCodeAt(index);
  if (code < SPACE_CODE) {
    return code === LF_CODE || code === TAB_CODE || code === CR_CODE ? 1 : 0;
  }
  if (code < HIGH_SURROGATE_CODE) {
    return 1;
  }
  if (code < LOW_SURROGATE_CODE) {
    const next = xml.charCodeAt(index + 1);
    return next >= LOW_SURROGATE_CODE && next < PRIVATE_USE_CODE ? 2 : 0;
  }
  return code < PRIVATE_USE_CODE || code >= NON_CHARACTER_CODE ? 0 : 1;
};

export const nextNonCharacter = (xml: string, from: number) => {
  LOW_CONTROLS.lastIndex = from;
  const other = Math.min(
    LOW_CONTROLS.exec(xml)?.index ?? xml.length,
    nextIndexOf(xml, "\uFFFE", from),
    nextIndexOf(xml, "\uFFFF", from),
  );
  const pattern = HIGH_CONTROLS_AND_SURROGATES;
  pattern.lastIndex = from;
  while (pattern.test(xml) && pattern.lastIndex <= other) {
    const index = pattern.lastIndex - 1;
    const width = characterWidth(xml, index);
    if (width === 0) {
      return index;
    }
    pattern.lastIndex = index + width;
  }
  return other;
};

export const localName = (qname: string) => {
  const colon = qname.indexOf(":");
  return colon === -1 ? qname : qname.slice(colon + 1);
};

export const positionAt = (xml: string, offset: number): XmlPosition => {
  const end = Math.min(Math.max(offset, 0), xml.length);
  const breaks = Array.from(
    xml.slice(0, end + 1).matchAll(LINE_BREAKS),
    ({ index }) => index,
  ).filter((index) => index < end);
  const lineStart = (breaks.at(-1) ?? -1) + 1;
  return { column: end - lineStart + 1, line: breaks.length + 1, offset: end };
};
