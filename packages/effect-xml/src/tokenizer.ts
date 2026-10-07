/* oxlint-disable unicorn/prefer-code-point -- the checks compare UTF-16 code units */
import { Result } from "effect";
import { characterWidth, nextIndexOf, nextNonCharacter, positionAt } from "./characters.ts";
import { XmlParseError } from "./errors/xml-parse-error.ts";
import type { TokenHandler, Tokenize } from "./types.ts";

const TAB = "\t";
const LF = "\n";
const CR = "\r";
const SPACE = " ";
const DOUBLE_QUOTE = '"';
const HASH = "#";
const AMPERSAND = "&";
const SINGLE_QUOTE = "'";
const SEMICOLON = ";";
const LT = "<";
const EQUALS = "=";
const GT = ">";
const LOWER_X = "x";
const BOM = "\uFEFF";
const TAB_CODE = 0x09;
const LF_CODE = 0x0a;
const CR_CODE = 0x0d;
const SPACE_CODE = 0x20;
const BANG_CODE = 0x21;
const AMPERSAND_CODE = 0x26;
const DASH_CODE = 0x2d;
const DOT_CODE = 0x2e;
const SLASH_CODE = 0x2f;
const DIGIT_ZERO_CODE = 0x30;
const DIGIT_NINE_CODE = 0x39;
const COLON_CODE = 0x3a;
const LT_CODE = 0x3c;
const GT_CODE = 0x3e;
const QUESTION_CODE = 0x3f;
const UPPER_A_CODE = 0x41;
const UPPER_Z_CODE = 0x5a;
const UNDERSCORE_CODE = 0x5f;
const LOWER_A_CODE = 0x61;
const LOWER_Z_CODE = 0x7a;
const ASCII_LAST_CODE = 0x7f;
const HIGH_SURROGATE_CODE = 0xd8_00;
const LOW_SURROGATE_CODE = 0xdc_00;
const PRIVATE_USE_CODE = 0xe0_00;
const DECIMAL_DIGITS = /^[0-9]+$/u;
const HEX_DIGITS = /^[0-9A-Fa-f]+$/u;
const XML_TARGET = "xml";
const CDATA_END = "]]>";
const XML_DECLARATION =
  /^<\?xml[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(?:"1\.\d+"|'1\.\d+')(?:[ \t\r\n]+encoding[ \t\r\n]*=[ \t\r\n]*(?:"[A-Za-z][\w.-]*"|'[A-Za-z][\w.-]*'))?(?:[ \t\r\n]+standalone[ \t\r\n]*=[ \t\r\n]*(?:"(?:yes|no)"|'(?:yes|no)'))?[ \t\r\n]*\?>$/u;

export const DEFAULT_MAX_DEPTH = 256;
const DUPLICATE_SCAN_LIMIT = 32;
const SHORT_TEXT = 128;
const LONG_TEXT = 1024;
const MAX_CODE_POINT = 0x10_ff_ff;

const STOPPED_CODE = -1;
const FAILED_CODE = -2;

const TEXT = 0;
const ATTRIBUTE = 1;
const CDATA = 2;

const INVALID_REFERENCE = "Unknown or malformed entity reference";
const INVALID_CHARACTER = "Character not allowed in XML 1.0";
const PREDEFINED_ENTITIES = [
  ["lt", 0x3c],
  ["gt", 0x3e],
  ["amp", 0x26],
  ["quot", 0x22],
  ["apos", 0x27],
] as const;

const ALLOWED_CONTROL_CODES: ReadonlySet<number> = new Set([0x9, 0xa, 0xd]);

const COMPLETED = Result.succeed(true);
const STOPPED = Result.succeed(false);

interface Replacement {
  readonly end: number;
  readonly start: number;
  readonly text: string;
}

const replaceSegments = (
  xml: string,
  start: number,
  end: number,
  replacements: readonly Replacement[],
) =>
  replacements.length === 0
    ? xml.slice(start, end)
    : replacements
        .map(
          (replacement, index) =>
            xml.slice(replacements[index - 1]?.end ?? start, replacement.start) + replacement.text,
        )
        .join("") + xml.slice(replacements.at(-1)?.end ?? start, end);

const isNameStart = (xml: string, index: number) => {
  const code = xml.charCodeAt(index);
  if (code >= LOWER_A_CODE) {
    return (
      code <= LOWER_Z_CODE ||
      (code > ASCII_LAST_CODE && (code < HIGH_SURROGATE_CODE || characterWidth(xml, index) > 0))
    );
  }
  if (code >= UPPER_A_CODE) {
    return code <= UPPER_Z_CODE || code === UNDERSCORE_CODE;
  }
  return code === COLON_CODE;
};

const nameEnd = (xml: string, start: number) => {
  for (let index = start; ; index += 1) {
    const code = xml.charCodeAt(index);
    if (code >= LOWER_A_CODE) {
      if (code > LOWER_Z_CODE) {
        if (code <= ASCII_LAST_CODE) {
          return index;
        }
        if (code >= HIGH_SURROGATE_CODE) {
          const previous = xml.charCodeAt(index - 1);
          const width =
            index === start && code >= LOW_SURROGATE_CODE && code < PRIVATE_USE_CODE
              ? Number(previous >= HIGH_SURROGATE_CODE && previous < LOW_SURROGATE_CODE)
              : characterWidth(xml, index);
          if (width === 0) {
            return index;
          }
          index += width - 1;
        }
      }
    } else if (code >= UPPER_A_CODE) {
      if (code > UPPER_Z_CODE && code !== UNDERSCORE_CODE) {
        return index;
      }
    } else if (code >= DIGIT_ZERO_CODE) {
      if (code > DIGIT_NINE_CODE && code !== COLON_CODE) {
        return index;
      }
    } else if (code !== DASH_CODE && code !== DOT_CODE) {
      return index;
    }
  }
};

const whitespaceEnd = (xml: string, start: number) => {
  for (let index = start; ; index += 1) {
    const code = xml.charCodeAt(index);
    if (code !== SPACE_CODE && code !== LF_CODE && code !== TAB_CODE && code !== CR_CODE) {
      return index;
    }
  }
};

class Scanner {
  readonly attributeNames: string[] = [];
  readonly attributeSet = new Set<string>();
  depth = 0;
  failure: XmlParseError | undefined;
  readonly handler: TokenHandler;
  readonly maxDepth: number;
  nextAmpersand = -1;
  nextCarriageReturn = -1;
  nextCdataEnd = -1;
  nextLineFeed = -1;
  nextNonCharacter = -1;
  nextTab = -1;
  referenceEnd = 0;
  rootSeen = false;
  readonly stack: string[] = [];
  readonly xml: string;

  constructor(xml: string, handler: TokenHandler, maxDepth: number) {
    this.xml = xml;
    this.handler = handler;
    this.maxDepth = maxDepth;
  }

  run(): Result.Result<boolean, XmlParseError> {
    const { xml } = this;
    const { length } = xml;
    const documentStart = xml.startsWith(BOM) ? 1 : 0;
    for (let position = documentStart; ;) {
      if (position === STOPPED_CODE) {
        return STOPPED;
      }
      if (position < 0 || position >= length) {
        break;
      }
      const lt = this.text(position);
      if (lt < 0 || lt >= length) {
        position = lt;
      } else {
        const marker = xml.charCodeAt(lt + 1);
        if (marker === SLASH_CODE) {
          position = this.closeTag(lt);
        } else if (marker === BANG_CODE) {
          position = this.markup(lt);
        } else if (marker === QUESTION_CODE) {
          position = this.instruction(lt, documentStart);
        } else {
          position = this.openTag(lt);
        }
      }
    }
    if (this.depth > 0) {
      this.fail(length, `Unclosed element <${this.stack[this.depth - 1] ?? ""}>`);
    } else if (!this.rootSeen) {
      this.fail(length, "Missing root element");
    }
    return this.failure === undefined ? COMPLETED : Result.fail(this.failure);
  }

  fail(offset: number, message: string) {
    this.failure ??= XmlParseError.make({
      position: positionAt(this.xml, offset),
      reason: message,
    });
    return FAILED_CODE;
  }

  failCharacter(offset: number, message: string) {
    return this.fail(offset, characterWidth(this.xml, offset) === 0 ? INVALID_CHARACTER : message);
  }

  text(position: number) {
    const { xml } = this;
    const contentStart = whitespaceEnd(xml, position);
    const lt =
      xml.charCodeAt(contentStart) === LT_CODE ? contentStart : xml.indexOf(LT, contentStart);
    const textEnd = lt === -1 ? xml.length : lt;
    if (textEnd === position) {
      return textEnd;
    }
    if (this.depth === 0) {
      return contentStart < textEnd
        ? this.fail(contentStart, "Text is not allowed outside the root element")
        : textEnd;
    }
    if (contentStart === textEnd && this.handler.keepWhitespace?.() !== true) {
      return textEnd;
    }
    if (this.nextCdataEnd < position) {
      this.nextCdataEnd = nextIndexOf(xml, CDATA_END, position);
    }
    if (this.nextCdataEnd < textEnd) {
      return this.fail(this.nextCdataEnd, "']]>' is not allowed in text");
    }
    if (this.isPlainText(position, textEnd)) {
      return this.handler.text(xml.slice(position, textEnd), position) ? textEnd : STOPPED_CODE;
    }
    const value = this.decode(position, textEnd, TEXT);
    if (this.failure !== undefined) {
      return FAILED_CODE;
    }
    return this.handler.text(value, position) ? textEnd : STOPPED_CODE;
  }

  isPlainText(start: number, end: number) {
    const { xml } = this;
    if (end - start <= SHORT_TEXT) {
      for (let index = start; index < end; index += 1) {
        const code = xml.charCodeAt(index);
        if (
          code < SPACE_CODE
            ? code !== LF_CODE && code !== TAB_CODE
            : code === AMPERSAND_CODE || code >= HIGH_SURROGATE_CODE
        ) {
          return false;
        }
      }
      return true;
    }
    if (this.nextAmpersand < start) {
      this.nextAmpersand = nextIndexOf(xml, AMPERSAND, start);
    }
    if (this.nextCarriageReturn < start) {
      this.nextCarriageReturn = nextIndexOf(xml, CR, start);
    }
    return (
      this.nextAmpersand >= end &&
      this.nextCarriageReturn >= end &&
      this.nonCharacterAfter(end, start)
    );
  }

  nonCharacterAfter(end: number, start: number) {
    if (this.nextNonCharacter < start) {
      this.nextNonCharacter = nextNonCharacter(this.xml, start);
    }
    return this.nextNonCharacter >= end;
  }

  closeTag(lt: number) {
    const { xml } = this;
    if (this.depth === 0) {
      return this.fail(lt, "Unexpected closing tag outside the root element");
    }
    const name = this.stack[this.depth - 1] ?? "";
    const afterName = lt + 2 + name.length;
    const matches = xml.slice(lt + 2, afterName) === name;
    const gt = matches ? whitespaceEnd(xml, afterName) : afterName;
    if (!matches || xml.charCodeAt(gt) !== GT_CODE) {
      if (matches && characterWidth(xml, gt) === 0) {
        return this.fail(gt, INVALID_CHARACTER);
      }
      const found = xml.slice(lt + 2, nameEnd(xml, lt + 2));
      return this.fail(
        lt,
        found === name
          ? `Malformed closing tag </${name}>`
          : `Closing tag </${found}> does not match <${name}>`,
      );
    }
    this.depth -= 1;
    return this.handler.close() ? gt + 1 : STOPPED_CODE;
  }

  markup(lt: number) {
    const { xml } = this;
    if (xml.startsWith("--", lt + 2)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end === -1) {
        return this.fail(lt, "Unterminated comment");
      }
      const doubleHyphen = xml.indexOf("--", lt + 4);
      return doubleHyphen < end
        ? this.fail(doubleHyphen, "'--' is not allowed inside a comment")
        : end + 3;
    }
    if (xml.startsWith("[CDATA[", lt + 2)) {
      return this.cdata(lt);
    }
    if (xml.startsWith("DOCTYPE", lt + 2)) {
      return this.fail(lt, "DOCTYPE declarations are not allowed");
    }
    if (xml.startsWith("ENTITY", lt + 2)) {
      return this.fail(lt, "ENTITY declarations are not allowed");
    }
    return this.fail(lt, "Invalid markup declaration");
  }

  cdata(lt: number) {
    const { xml } = this;
    if (this.depth === 0) {
      return this.fail(lt, "CDATA is not allowed outside the root element");
    }
    const start = lt + 9;
    const end = xml.indexOf("]]>", start);
    if (end === -1) {
      return this.fail(lt, "Unterminated CDATA section");
    }
    if (end === start) {
      return end + 3;
    }
    if (!this.nonCharacterAfter(end, start)) {
      return this.fail(this.nextNonCharacter, INVALID_CHARACTER);
    }
    if (this.nextCarriageReturn < start) {
      this.nextCarriageReturn = nextIndexOf(xml, CR, start);
    }
    const value =
      this.nextCarriageReturn < end ? this.decode(start, end, CDATA) : xml.slice(start, end);
    return this.handler.text(value, lt) ? end + 3 : STOPPED_CODE;
  }

  instruction(lt: number, documentStart: number) {
    const { xml } = this;
    const end = xml.indexOf("?>", lt + 2);
    if (end === -1) {
      return this.fail(lt, "Unterminated processing instruction");
    }
    if (!isNameStart(xml, lt + 2)) {
      return characterWidth(xml, lt + 2) === 0
        ? this.fail(lt + 2, INVALID_CHARACTER)
        : this.fail(lt, "Invalid processing instruction target");
    }
    const targetEnd = nameEnd(xml, lt + 3);
    if (characterWidth(xml, targetEnd) === 0) {
      return this.fail(targetEnd, INVALID_CHARACTER);
    }
    const target = xml.slice(lt + 2, targetEnd);
    if (lt !== documentStart && target.toLowerCase() === XML_TARGET) {
      return this.fail(lt, "The XML declaration is only allowed at the start of the document");
    }
    if (target === XML_TARGET && !XML_DECLARATION.test(xml.slice(lt, end + 2))) {
      return this.fail(
        lt,
        'Malformed XML declaration: expected version="1.x", then optional encoding and standalone',
      );
    }
    return end + 2;
  }

  openTag(lt: number) {
    const { xml } = this;
    if (!isNameStart(xml, lt + 1)) {
      return this.failCharacter(lt + 1, "Invalid element name");
    }
    if (this.depth === 0 && this.rootSeen) {
      return this.fail(lt, "Only one root element is allowed");
    }
    if (this.depth >= this.maxDepth) {
      return this.fail(lt, `Maximum element depth of ${String(this.maxDepth)} exceeded`);
    }
    const afterName = nameEnd(xml, lt + 2);
    const name = xml.slice(lt + 1, afterName);
    if (!this.handler.openStart(name, lt)) {
      return STOPPED_CODE;
    }
    this.rootSeen = true;
    for (let count = 0, index = afterName; ; count += 1) {
      if (index < 0) {
        return index;
      }
      const next = whitespaceEnd(xml, index);
      const code = xml.charCodeAt(next);
      if (code === GT_CODE) {
        this.stack[this.depth] = name;
        this.depth += 1;
        return this.handler.openEnd() ? next + 1 : STOPPED_CODE;
      }
      if (code === SLASH_CODE) {
        return this.emptyElementEnd(next);
      }
      if (next >= xml.length) {
        return this.fail(lt, `Unterminated start tag <${name}>`);
      }
      if (!isNameStart(xml, next)) {
        return this.failCharacter(next, `Unexpected character in start tag <${name}>`);
      }
      if (next === index) {
        return this.fail(next, "Missing whitespace before attribute");
      }
      index = this.attribute(next, count);
    }
  }

  emptyElementEnd(slash: number) {
    if (this.xml[slash + 1] !== GT) {
      return this.fail(slash, "Expected '>' after '/' in an empty-element tag");
    }
    return this.handler.openEnd() && this.handler.close() ? slash + 2 : STOPPED_CODE;
  }

  attribute(start: number, count: number) {
    const { xml } = this;
    const afterName = nameEnd(xml, start + 1);
    const name = xml.slice(start, afterName);
    if (this.isDuplicate(name, count)) {
      return this.fail(start, `Duplicate attribute ${name}`);
    }
    const equals = whitespaceEnd(xml, afterName);
    if (xml[equals] !== EQUALS) {
      return this.failCharacter(equals, `Expected '=' after attribute ${name}`);
    }
    const quoteIndex = whitespaceEnd(xml, equals + 1);
    const quote = xml[quoteIndex] ?? "";
    if (quote !== DOUBLE_QUOTE && quote !== SINGLE_QUOTE) {
      return this.fail(quoteIndex, `Expected a quoted value for attribute ${name}`);
    }
    const valueStart = quoteIndex + 1;
    const valueEnd = xml.indexOf(quote, valueStart);
    if (valueEnd === -1) {
      return this.fail(quoteIndex, `Unterminated value for attribute ${name}`);
    }
    const lt = nextIndexOf(xml, LT, valueStart);
    return lt < valueEnd
      ? this.fail(lt, "'<' is not allowed in attribute values")
      : this.emitAttribute(name, this.decode(valueStart, valueEnd, ATTRIBUTE), start, valueEnd);
  }

  emitAttribute(name: string, value: string, start: number, valueEnd: number) {
    if (this.failure !== undefined) {
      return FAILED_CODE;
    }
    return this.handler.attribute(name, value, start) ? valueEnd + 1 : STOPPED_CODE;
  }

  isDuplicate(name: string, count: number) {
    const { attributeNames, attributeSet } = this;
    if (count < DUPLICATE_SCAN_LIMIT) {
      for (let seen = 0; seen < count; seen += 1) {
        if (attributeNames[seen] === name) {
          return true;
        }
      }
      attributeNames[count] = name;
      return false;
    }
    if (count === DUPLICATE_SCAN_LIMIT) {
      attributeSet.clear();
      for (let seen = 0; seen < count; seen += 1) {
        attributeSet.add(attributeNames[seen] ?? "");
      }
    }
    if (attributeSet.has(name)) {
      return true;
    }
    attributeSet.add(name);
    return false;
  }

  nextMarker(from: number, mode: typeof ATTRIBUTE | typeof CDATA | typeof TEXT) {
    const { xml } = this;
    if (this.nextCarriageReturn < from) {
      this.nextCarriageReturn = nextIndexOf(xml, CR, from);
    }
    if (this.nextNonCharacter < from) {
      this.nextNonCharacter = nextNonCharacter(xml, from);
    }
    const cdataMarker = Math.min(this.nextCarriageReturn, this.nextNonCharacter);
    if (mode === CDATA) {
      return cdataMarker;
    }
    if (this.nextAmpersand < from) {
      this.nextAmpersand = nextIndexOf(xml, AMPERSAND, from);
    }
    const next = Math.min(cdataMarker, this.nextAmpersand);
    if (mode === TEXT) {
      return next;
    }
    if (this.nextLineFeed < from) {
      this.nextLineFeed = nextIndexOf(xml, LF, from);
    }
    if (this.nextTab < from) {
      this.nextTab = nextIndexOf(xml, TAB, from);
    }
    return Math.min(next, this.nextLineFeed, this.nextTab);
  }

  decodeLong(start: number, end: number, mode: typeof ATTRIBUTE | typeof CDATA | typeof TEXT) {
    const { xml } = this;
    const replacements: Replacement[] = [];
    for (let index = this.nextMarker(start, mode); index < end;) {
      const char = xml[index];
      if (char === AMPERSAND) {
        const codePoint = this.reference(index, end);
        if (codePoint < 0) {
          this.fail(index, INVALID_REFERENCE);
          return "";
        }
        replacements.push({
          end: this.referenceEnd,
          start: index,
          text: String.fromCodePoint(codePoint),
        });
        index = this.nextMarker(this.referenceEnd, mode);
      } else if (char === CR) {
        const after = index + (index + 1 < end && xml[index + 1] === LF ? 2 : 1);
        replacements.push({ end: after, start: index, text: mode === ATTRIBUTE ? SPACE : LF });
        index = this.nextMarker(after, mode);
      } else if (char === LF || char === TAB) {
        replacements.push({ end: index + 1, start: index, text: SPACE });
        index = this.nextMarker(index + 1, mode);
      } else {
        this.fail(index, INVALID_CHARACTER);
        return "";
      }
    }
    return replaceSegments(xml, start, end, replacements);
  }

  decode(start: number, end: number, mode: typeof ATTRIBUTE | typeof CDATA | typeof TEXT) {
    if (end - start > LONG_TEXT) {
      return this.decodeLong(start, end, mode);
    }
    const { xml } = this;
    const replacements: Replacement[] = [];
    for (let index = start; index < end;) {
      const code = xml.charCodeAt(index);
      if (code === AMPERSAND_CODE && mode !== CDATA) {
        const codePoint = this.reference(index, end);
        if (codePoint < 0) {
          this.fail(index, INVALID_REFERENCE);
          return "";
        }
        replacements.push({
          end: this.referenceEnd,
          start: index,
          text: String.fromCodePoint(codePoint),
        });
        index = this.referenceEnd;
      } else if (code === CR_CODE) {
        const after = index + (index + 1 < end && xml[index + 1] === LF ? 2 : 1);
        replacements.push({ end: after, start: index, text: mode === ATTRIBUTE ? SPACE : LF });
        index = after;
      } else if (mode === ATTRIBUTE && (code === LF_CODE || code === TAB_CODE)) {
        replacements.push({ end: index + 1, start: index, text: SPACE });
        index += 1;
      } else if (
        code < SPACE_CODE ? code !== LF_CODE && code !== TAB_CODE : code >= HIGH_SURROGATE_CODE
      ) {
        const width = characterWidth(xml, index);
        if (width === 0) {
          this.fail(index, INVALID_CHARACTER);
          return "";
        }
        index += width;
      } else {
        index += 1;
      }
    }
    return replaceSegments(xml, start, end, replacements);
  }

  reference(ampersand: number, limit: number) {
    const { xml } = this;
    if (xml[ampersand + 1] === HASH) {
      return this.characterReference(ampersand, limit);
    }
    for (const [name, codePoint] of PREDEFINED_ENTITIES) {
      const semicolon = ampersand + 1 + name.length;
      if (
        semicolon < limit &&
        xml[semicolon] === SEMICOLON &&
        xml.startsWith(name, ampersand + 1)
      ) {
        this.referenceEnd = semicolon + 1;
        return codePoint;
      }
    }
    return -1;
  }

  characterReference(ampersand: number, limit: number) {
    const { xml } = this;
    const radix = xml[ampersand + 2] === LOWER_X ? 16 : 10;
    const digitsStart = ampersand + (radix === 16 ? 3 : 2);
    const semicolon = xml.indexOf(SEMICOLON, digitsStart);
    const digits = semicolon === -1 || semicolon >= limit ? "" : xml.slice(digitsStart, semicolon);
    const value = (radix === 16 ? HEX_DIGITS : DECIMAL_DIGITS).test(digits)
      ? Number.parseInt(digits, radix)
      : -1;
    const legal =
      value >= 0x20
        ? value <= 0xd7_ff ||
          (value >= 0xe0_00 && value <= 0xff_fd) ||
          (value >= 0x1_00_00 && value <= MAX_CODE_POINT)
        : ALLOWED_CONTROL_CODES.has(value);
    if (!legal) {
      return -1;
    }
    this.referenceEnd = semicolon + 1;
    return value;
  }
}

export const tokenize: Tokenize = (xml, handler, options) =>
  new Scanner(xml, handler, options?.maxDepth ?? DEFAULT_MAX_DEPTH).run();
