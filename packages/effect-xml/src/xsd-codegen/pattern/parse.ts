import { Result } from "effect";
import * as CharSet from "../charset.ts";

export type RegexNode =
  | { readonly kind: "set"; readonly set: CharSet.CharSet }
  | { readonly kind: "sequence"; readonly items: readonly RegexNode[] }
  | { readonly kind: "choice"; readonly branches: readonly RegexNode[] }
  | {
      readonly kind: "repeat";
      readonly node: RegexNode;
      readonly min: number;
      readonly max: number | undefined;
    };

type Parsed<A> = Result.Result<A, string>;

interface Consumed<A> {
  readonly next: number;
  readonly value: A;
}

type Escape =
  | { readonly kind: "char"; readonly codePoint: number }
  | { readonly kind: "set"; readonly set: CharSet.CharSet };

const BLOCKS: ReadonlyMap<string, CharSet.CharSet> = new Map([
  ["IsBasicLatin", CharSet.make([0x00, 0x7f])],
  ["IsLatin-1Supplement", CharSet.make([0x80, 0xff])],
  ["IsLatinExtended-A", CharSet.make([0x1_00, 0x1_7f])],
  ["IsLatinExtended-B", CharSet.make([0x1_80, 0x2_4f])],
  ["IsIPAExtensions", CharSet.make([0x2_50, 0x2_af])],
  ["IsSpacingModifierLetters", CharSet.make([0x2_b0, 0x2_ff])],
  ["IsCombiningDiacriticalMarks", CharSet.make([0x3_00, 0x3_6f])],
  ["IsGreek", CharSet.make([0x3_70, 0x3_ff])],
  ["IsCyrillic", CharSet.make([0x4_00, 0x4_ff])],
  ["IsLatinExtendedAdditional", CharSet.make([0x1e_00, 0x1e_ff])],
  ["IsGeneralPunctuation", CharSet.make([0x20_00, 0x20_6f])],
  ["IsCurrencySymbols", CharSet.make([0x20_a0, 0x20_cf])],
]);

const CODE_POINTS = /[\s\S]/gu;

const SINGLE_ESCAPES: ReadonlyMap<string, number> = new Map([
  ["n", CharSet.LINE_FEED],
  ["r", CharSet.CARRIAGE_RETURN],
  ["t", CharSet.TAB],
  ["\\", 0x5c],
  ["|", 0x7c],
  [".", 0x2e],
  ["?", 0x3f],
  ["*", 0x2a],
  ["+", 0x2b],
  ["(", 0x28],
  [")", 0x29],
  ["{", 0x7b],
  ["}", 0x7d],
  ["-", 0x2d],
  ["[", 0x5b],
  ["]", 0x5d],
  ["^", 0x5e],
]);

const UNSUPPORTED_MULTI_ESCAPES = new Set(["c", "C", "d", "D", "i", "I", "w", "W"]);

const set = (value: CharSet.CharSet): RegexNode => ({
  kind: "set",
  set: CharSet.intersect(value, CharSet.XML_CHAR),
});

export const choice = (branches: readonly RegexNode[]): RegexNode =>
  branches.length === 1 && branches[0] !== undefined ? branches[0] : { branches, kind: "choice" };

export const parse = (source: string): Parsed<RegexNode> => {
  const chars = Array.from(source.matchAll(CODE_POINTS), ([char]) => char);
  const failAt = (at: number, message: string) =>
    Result.fail(
      `${message} at character ${String(at + 1)} of the pattern ${JSON.stringify(source)}`,
    );

  const parseProperty = (escaped: string, at: number): Parsed<Consumed<Escape>> =>
    Result.gen(function* parseCategoryEscape() {
      const open = at + 1;
      if (chars[open] !== "{") {
        return yield* failAt(open, `Expected '{' after \\${escaped}`);
      }
      const close = chars.indexOf("}", open);
      if (close === -1) {
        return yield* failAt(open, `The escape \\${escaped}{ is not closed`);
      }
      const name = chars.slice(open + 1, close).join("");
      const block = BLOCKS.get(name);
      if (block === undefined) {
        return yield* failAt(
          open,
          name.startsWith("Is")
            ? `The Unicode block ${name} is not supported`
            : `The Unicode category \\${escaped}{${name}} depends on the Unicode tables of the validator and has no exact JavaScript translation`,
        );
      }
      return {
        next: close + 1,
        value: { kind: "set", set: escaped === "p" ? block : CharSet.complement(block) },
      } as const;
    });

  const parseEscape = (at: number): Parsed<Consumed<Escape>> =>
    Result.gen(function* parseXsdEscape() {
      const escapedAt = at + 1;
      const escaped = chars[escapedAt];
      if (escaped === undefined) {
        return yield* failAt(escapedAt, "The pattern ends with a lone backslash");
      }
      const single = SINGLE_ESCAPES.get(escaped);
      if (single !== undefined) {
        return { next: escapedAt + 1, value: { codePoint: single, kind: "char" } } as const;
      }
      if (escaped === "s" || escaped === "S") {
        return {
          next: escapedAt + 1,
          value: {
            kind: "set",
            set: escaped === "s" ? CharSet.WHITESPACE : CharSet.complement(CharSet.WHITESPACE),
          },
        } as const;
      }
      if (UNSUPPORTED_MULTI_ESCAPES.has(escaped)) {
        return yield* failAt(
          escapedAt,
          `The escape \\${escaped} depends on the Unicode tables of the validator and has no exact JavaScript translation`,
        );
      }
      if (escaped === "p" || escaped === "P") {
        return yield* parseProperty(escaped, escapedAt);
      }
      return yield* failAt(escapedAt, `The escape \\${escaped} is not valid in an XSD pattern`);
    });

  const parseRangeEnd = (at: number): Parsed<Consumed<number>> =>
    Result.gen(function* parseXsdRangeEnd() {
      const char = chars[at];
      if (char === undefined) {
        return yield* failAt(at, "The character class is not closed");
      }
      if (char === "[" || char === "]" || char === "-") {
        return yield* failAt(at, `'${char}' cannot end a range`);
      }
      if (char !== "\\") {
        return { next: at + 1, value: char.codePointAt(0) ?? 0 };
      }
      const escape = yield* parseEscape(at);
      return escape.value.kind === "set"
        ? yield* failAt(escape.next, "A multi-character escape cannot end a range")
        : { next: escape.next, value: escape.value.codePoint };
    });

  const parseClassItem = (groupStart: number, at: number): Parsed<Consumed<CharSet.CharSet>> =>
    Result.gen(function* parseCharRange() {
      const char = chars[at] ?? "";
      if (char === "-") {
        if (at !== groupStart && chars[at + 1] !== "]") {
          return yield* failAt(
            at,
            "A '-' inside a character class is only exact at its start or end",
          );
        }
        return { next: at + 1, value: CharSet.single(0x2d) };
      }
      if (char === "[") {
        return yield* failAt(at, "An unescaped '[' is not valid inside a character class");
      }
      const escape = char === "\\" ? yield* parseEscape(at) : undefined;
      if (escape?.value.kind === "set") {
        return { next: escape.next, value: escape.value.set };
      }
      const start = escape === undefined ? (char.codePointAt(0) ?? 0) : escape.value.codePoint;
      const afterStart = escape?.next ?? at + 1;
      if (
        chars[afterStart] !== "-" ||
        chars[afterStart + 1] === "]" ||
        chars[afterStart + 1] === "["
      ) {
        return { next: afterStart, value: CharSet.single(start) };
      }
      const end = yield* parseRangeEnd(afterStart + 1);
      return end.value < start
        ? yield* failAt(end.next, "The range ends before it starts")
        : { next: end.next, value: CharSet.make([start, end.value]) };
    });

  const parseClass = (at: number): Parsed<Consumed<CharSet.CharSet>> =>
    Result.gen(function* parseCharClassExpr() {
      const negated = chars[at + 1] === "^";
      const groupStart = negated ? at + 2 : at + 1;
      const ranges: CharSet.CharSet[] = [];
      for (let index = groupStart; ;) {
        const char = chars[index];
        if (char === undefined) {
          return yield* failAt(index, "The character class is not closed");
        }
        const subtracting = char === "-" && chars[index + 1] === "[" && index !== groupStart;
        if (char === "]" || subtracting) {
          const subtracted = subtracting ? yield* parseClass(index + 1) : undefined;
          const close = subtracted?.next ?? index;
          if (chars[close] !== "]") {
            return yield* failAt(close, "A character class subtraction must end its class");
          }
          if (ranges.length === 0) {
            return yield* failAt(close + 1, "The character class is empty");
          }
          const group = CharSet.union(...ranges);
          const positive = negated
            ? CharSet.complement(group)
            : CharSet.intersect(group, CharSet.XML_CHAR);
          return {
            next: close + 1,
            value:
              subtracted === undefined ? positive : CharSet.subtract(positive, subtracted.value),
          };
        }
        const item = yield* parseClassItem(groupStart, index);
        ranges.push(item.value);
        index = item.next;
      }
    });

  const parseNumber = (at: number): Consumed<number | undefined> => {
    const length = chars.slice(at).findIndex((char) => !/^[0-9]$/u.test(char));
    const next = length === -1 ? chars.length : at + length;
    const digits = chars.slice(at, next).join("");
    return { next, value: digits === "" ? undefined : Number(digits) };
  };

  const parseQuantifier = (node: RegexNode, at: number): Parsed<Consumed<RegexNode>> =>
    Result.gen(function* parseXsdQuantifier() {
      const char = chars[at];
      if (char === "?" || char === "*" || char === "+") {
        return {
          next: at + 1,
          value: {
            kind: "repeat",
            max: char === "?" ? 1 : undefined,
            min: char === "+" ? 1 : 0,
            node,
          },
        } as const;
      }
      if (char !== "{") {
        return { next: at, value: node };
      }
      const min = parseNumber(at + 1);
      if (min.value === undefined) {
        return yield* failAt(min.next, "A quantifier must start with a number");
      }
      const max = chars[min.next] === "," ? parseNumber(min.next + 1) : min;
      if (chars[max.next] !== "}") {
        return yield* failAt(max.next, "The quantifier is not closed");
      }
      if (max.value !== undefined && max.value < min.value) {
        return yield* failAt(max.next + 1, "The quantifier maximum is below its minimum");
      }
      return {
        next: max.next + 1,
        value: { kind: "repeat", max: max.value, min: min.value, node },
      } as const;
    });

  const parseAtom = (
    parseRegExp: (at: number) => Parsed<Consumed<RegexNode>>,
    at: number,
  ): Parsed<Consumed<RegexNode>> =>
    Result.gen(function* parseXsdAtom() {
      const char = chars[at] ?? "";
      if (char === "(") {
        const inner = yield* parseRegExp(at + 1);
        if (chars[inner.next] !== ")") {
          return yield* failAt(inner.next, "The group is not closed");
        }
        return { next: inner.next + 1, value: inner.value };
      }
      if (char === "[") {
        const group = yield* parseClass(at);
        return { next: group.next, value: set(group.value) };
      }
      if (char === "\\") {
        const escape = yield* parseEscape(at);
        return {
          next: escape.next,
          value: set(
            escape.value.kind === "set" ? escape.value.set : CharSet.single(escape.value.codePoint),
          ),
        };
      }
      if (char === ".") {
        return { next: at + 1, value: set(CharSet.complement(CharSet.LINE_BREAKS)) };
      }
      if (char === "{") {
        return yield* failAt(at, "A '{' is only exact as a quantifier after an atom");
      }
      if ("?*+)]".includes(char)) {
        return yield* failAt(at, `Unexpected '${char}'`);
      }
      return { next: at + 1, value: set(CharSet.single(char.codePointAt(0) ?? 0)) };
    });

  const parseRegExp = (at: number): Parsed<Consumed<RegexNode>> =>
    Result.gen(function* parseXsdRegExp() {
      const branches: RegexNode[][] = [[]];
      for (let index = at; ;) {
        const char = chars[index];
        if (char === undefined || char === ")") {
          return {
            next: index,
            value: choice(
              branches.map((items): RegexNode => {
                const [only] = items;
                return items.length === 1 && only !== undefined
                  ? only
                  : { items, kind: "sequence" };
              }),
            ),
          };
        }
        if (char === "|") {
          branches.push([]);
          index += 1;
        } else {
          const atom = yield* parseAtom(parseRegExp, index);
          const quantified = yield* parseQuantifier(atom.value, atom.next);
          branches.at(-1)?.push(quantified.value);
          index = quantified.next;
        }
      }
    });

  return Result.gen(function* parseXsdPattern() {
    const node = yield* parseRegExp(0);
    if (node.next < chars.length) {
      return yield* failAt(node.next, `Unexpected '${chars[node.next] ?? ""}'`);
    }
    return node.value;
  });
};

const collectSets = (node: RegexNode): readonly CharSet.CharSet[] => {
  if (node.kind === "set") {
    return [node.set];
  }
  if (node.kind === "repeat") {
    return collectSets(node.node);
  }
  return (node.kind === "sequence" ? node.items : node.branches).flatMap(collectSets);
};

export const isBmpOnly = (node: RegexNode) => collectSets(node).every(CharSet.isBmp);
