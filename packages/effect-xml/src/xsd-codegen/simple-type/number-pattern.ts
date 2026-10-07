import * as CharSet from "../charset.ts";
import type { RegexNode } from "../pattern/parse.ts";

const DIGITS = CharSet.make([0x30, 0x39]);
const SIGNS = CharSet.union(CharSet.single(0x2b), CharSet.single(0x2d));
const DOT = CharSet.single(0x2e);
const FRACTION = /^\.[do]*$/u;
const INTEGER_TOKENS = /^s?[do]*d[do]*$/u;
const DECIMAL_TOKENS = /^s?[do]*d[do]*(?:\.[do]*|f)?$/u;

const isWithin = (node: RegexNode, allowed: CharSet.CharSet) =>
  node.kind === "set" &&
  !CharSet.isEmpty(node.set) &&
  CharSet.isEmpty(CharSet.subtract(node.set, allowed));

const tokens = (node: RegexNode): string => {
  if (node.kind === "sequence") {
    return node.items.map(tokens).join("");
  }
  const { max, min, node: item } = node.kind === "repeat" ? node : { max: 1, min: 1, node };
  if (isWithin(item, DIGITS)) {
    return min >= 1 ? "d" : "o";
  }
  if (max === 1 && isWithin(item, SIGNS)) {
    return "s";
  }
  if (min === 1 && max === 1 && isWithin(item, DOT)) {
    return ".";
  }
  return min === 0 && max === 1 && FRACTION.test(tokens(item)) ? "f" : "x";
};

/**
 * True when every string the pattern matches is also in the lexical space of xs:integer, or of
 * xs:decimal when `fraction` is true. The pattern is read as tokens: `s` sign, `d` required digits,
 * `o` optional digits, `.` dot, `f` optional fraction group, `x` anything else.
 */
export const impliesNumberLexical = (node: RegexNode, fraction: boolean): boolean =>
  node.kind === "choice"
    ? node.branches.every((branch) => impliesNumberLexical(branch, fraction))
    : (fraction ? DECIMAL_TOKENS : INTEGER_TOKENS).test(tokens(node));
