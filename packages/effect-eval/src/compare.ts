import type { Equivalence } from "effect";
import { BigDecimal, Equal } from "effect";
import { different, exact as same, partial } from "./agreement.ts";
import type { Agreement } from "./agreement.ts";
import { codePoints } from "./text.ts";

export type Compare<A> = (expected: A, actual: A) => Agreement;

const MIN_CONTAINED = 4;
const COMBINING_MARKS = /\p{M}/gu;
const NAME_PUNCTUATION = /[.,'"&()]/gu;
const WORD_SEPARATORS = /[\s/-]+/u;
const WHITESPACE = /\s+/gu;

export const normalize = (text: string) =>
  text.normalize("NFKC").trim().replaceAll(WHITESPACE, " ").toUpperCase();

export const exact =
  <A>(equivalence: Equivalence.Equivalence<A> = Equal.asEquivalence<A>()): Compare<A> =>
  (expected, actual) =>
    equivalence(expected, actual) ? same : different;

export const normalizedText =
  (normalizer: (text: string) => string = normalize): Compare<string> =>
  (expected, actual) =>
    normalizer(expected) === normalizer(actual) ? same : different;

export const tolerance =
  (limit: BigDecimal.BigDecimal): Compare<BigDecimal.BigDecimal> =>
  (expected, actual) =>
    BigDecimal.isLessThanOrEqualTo(BigDecimal.abs(BigDecimal.subtract(expected, actual)), limit)
      ? same
      : different;

export const numericTolerance =
  (limit: number, options: { readonly relative?: boolean } = {}): Compare<number> =>
  (expected, actual) =>
    Math.abs(expected - actual) <= (options.relative === true ? limit * Math.abs(expected) : limit)
      ? same
      : different;

export const levenshteinRatio = (left: string, right: string) => {
  const lefts = codePoints(left);
  const rights = codePoints(right);
  const longest = Math.max(lefts.length, rights.length);
  if (longest === 0) {
    return 1;
  }
  const row = Array.from({ length: rights.length + 1 }, (_, index) => index);
  for (const [index, character] of lefts.entries()) {
    const previous = [...row];
    row[0] = index + 1;
    for (const [column, other] of rights.entries()) {
      row[column + 1] = Math.min(
        (previous[column + 1] ?? 0) + 1,
        (row[column] ?? 0) + 1,
        (previous[column] ?? 0) + (character === other ? 0 : 1),
      );
    }
  }
  return 1 - (row[rights.length] ?? longest) / longest;
};

export const similarity =
  (options: { readonly normalize?: (text: string) => string } = {}): Compare<string> =>
  (expected, actual) => {
    const normalizer = options.normalize ?? normalize;
    return partial(levenshteinRatio(normalizer(expected), normalizer(actual)));
  };

const wordsOf = (normalizer: (text: string) => string, value: string) =>
  normalizer(
    value.normalize("NFKD").replaceAll(COMBINING_MARKS, "").replaceAll(NAME_PUNCTUATION, ""),
  )
    .split(WORD_SEPARATORS)
    .filter((word) => word.length > 0);

export const tokenSimilarity =
  (
    options: { readonly normalize?: (text: string) => string; readonly minContained?: number } = {},
  ): Compare<string> =>
  (expected, actual) => {
    const normalizer = options.normalize ?? normalize;
    const expectedWords = wordsOf(normalizer, expected);
    const actualWords = wordsOf(normalizer, actual);
    const expectedCompact = expectedWords.join("");
    const actualCompact = actualWords.join("");
    const contained =
      Math.min(expectedCompact.length, actualCompact.length) >=
        (options.minContained ?? MIN_CONTAINED) && actualCompact.includes(expectedCompact);
    if (expectedCompact === actualCompact || contained) {
      return same;
    }
    const letters = expectedWords.reduce((total, word) => total + word.length, 0);
    const wordScore =
      letters === 0
        ? 0
        : expectedWords.reduce(
            (total, word) =>
              total +
              word.length *
                Math.max(0, ...actualWords.map((candidate) => levenshteinRatio(word, candidate))),
            0,
          ) / letters;
    return partial(Math.max(wordScore, levenshteinRatio(expectedCompact, actualCompact)));
  };

export const subset =
  <A>(equivalence: Equivalence.Equivalence<A>): Compare<readonly A[]> =>
  (expected, actual) => {
    const contains = (items: readonly A[], item: A) =>
      items.some((candidate) => equivalence(candidate, item));
    const unique = (items: readonly A[]) =>
      items.filter((item, index) => !contains(items.slice(0, index), item));
    const wanted = unique(expected);
    const given = unique(actual);
    if (wanted.length === 0 && given.length === 0) {
      return same;
    }
    if (given.length === 0 || !given.every((item) => contains(wanted, item))) {
      return different;
    }
    return given.length === wanted.length ? same : partial(given.length / wanted.length);
  };

export const custom = <A>(f: (expected: A, actual: A) => Agreement): Compare<A> => f;

export const mapInput =
  <A, B>(f: (value: B) => A) =>
  (self: Compare<A>): Compare<B> =>
  (expected, actual) =>
    self(f(expected), f(actual));
