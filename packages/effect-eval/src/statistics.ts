/* oxlint-disable no-bitwise, unicorn/prefer-math-trunc -- FNV-1a and mulberry32 are defined on 32-bit integers */
import { Option } from "effect";

const DEFAULT_RESAMPLES = 2000;
const DEFAULT_CONFIDENCE = 0.95;
const QUANTILE_TAIL = 0.02425;
const FNV_OFFSET = 2_166_136_261;
const FNV_PRIME = 16_777_619;
const MULBERRY_INCREMENT = 0x6d_2b_79_f5;
const UINT32_RANGE = 4_294_967_296;

const polynomial = (coefficients: readonly number[], x: number) =>
  coefficients.reduce((total, coefficient) => total * x + coefficient, 0);

const tailQuantile = (q: number) =>
  polynomial(
    [
      -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734,
      4.374664141464968, 2.938163982698783,
    ],
    q,
  ) /
  (polynomial([0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416], q) *
    q +
    1);

export const normalQuantile = (p: number) => {
  if (p < QUANTILE_TAIL) {
    return tailQuantile(Math.sqrt(-2 * Math.log(p)));
  }
  if (p > 1 - QUANTILE_TAIL) {
    return -tailQuantile(Math.sqrt(-2 * Math.log(1 - p)));
  }
  const q = p - 0.5;
  const r = q * q;
  return (
    (polynomial(
      [
        -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269,
        -30.66479806614716, 2.506628277459239,
      ],
      r,
    ) *
      q) /
    (polynomial(
      [
        -54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972,
        -13.28068155288572,
      ],
      r,
    ) *
      r +
      1)
  );
};

export const wilson = (
  successes: number,
  n: number,
  options: { readonly confidence?: number } = {},
): Option.Option<readonly [number, number]> => {
  if (n <= 0) {
    return Option.none();
  }
  const z = normalQuantile(1 - (1 - (options.confidence ?? DEFAULT_CONFIDENCE)) / 2);
  const share = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (share + z2 / (2 * n)) / denominator;
  const half = (z * Math.sqrt((share * (1 - share)) / n + z2 / (4 * n * n))) / denominator;
  return Option.some([Math.max(0, center - half), Math.min(1, center + half)] as const);
};

export const seededRandom = (seed: string) => {
  const state = {
    value: Array.from(seed, (character) => character.codePointAt(0) ?? 0).reduce(
      (hash, code) => Math.imul(hash ^ code, FNV_PRIME) >>> 0,
      FNV_OFFSET,
    ),
  };
  return () => {
    state.value = (state.value + MULBERRY_INCREMENT) | 0;
    const first = Math.imul(state.value ^ (state.value >>> 15), 1 | state.value);
    const second = (first + Math.imul(first ^ (first >>> 7), 61 | first)) ^ first;
    return ((second ^ (second >>> 14)) >>> 0) / UINT32_RANGE;
  };
};

export const mean = (values: readonly number[]) =>
  values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;

export const standardDeviation = (values: readonly number[]) => {
  if (values.length < 2) {
    return 0;
  }
  const average = mean(values);
  return Math.sqrt(
    values.reduce((total, value) => total + (value - average) ** 2, 0) / (values.length - 1),
  );
};

interface ResampleOptions {
  readonly seed: string;
  readonly resamples?: number;
  readonly confidence?: number;
}

const percentiles = (
  sampled: readonly number[],
  confidence: number,
): Option.Option<readonly [number, number]> => {
  if (sampled.length === 0) {
    return Option.none();
  }
  const sorted = sampled.toSorted((left, right) => left - right);
  const tail = (1 - confidence) / 2;
  const at = (share: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(share * sorted.length)))] ?? 0;
  return Option.some([at(tail), at(1 - tail)] as const);
};

export const bootstrap = (
  values: readonly number[],
  options: ResampleOptions,
): Option.Option<readonly [number, number]> => {
  if (values.length === 0) {
    return Option.none();
  }
  const random = seededRandom(options.seed);
  return percentiles(
    Array.from({ length: options.resamples ?? DEFAULT_RESAMPLES }, () =>
      mean(Array.from(values, () => values[Math.floor(random() * values.length)] ?? 0)),
    ),
    options.confidence ?? DEFAULT_CONFIDENCE,
  );
};

export const pairedBootstrap = (
  pairs: readonly (readonly [before: number, after: number])[],
  options: ResampleOptions,
): Option.Option<readonly [number, number]> => {
  if (pairs.length === 0) {
    return Option.none();
  }
  const random = seededRandom(options.seed);
  const differences = pairs.map(([before, after]) => after - before);
  return percentiles(
    Array.from({ length: options.resamples ?? DEFAULT_RESAMPLES }, () =>
      mean(
        Array.from(differences, () => differences[Math.floor(random() * differences.length)] ?? 0),
      ),
    ),
    options.confidence ?? DEFAULT_CONFIDENCE,
  );
};

export const mcnemar = (onlyLeft: number, onlyRight: number) => {
  const n = onlyLeft + onlyRight;
  if (n === 0) {
    return { pValue: 1 };
  }
  const tail = Array.from({ length: Math.min(onlyLeft, onlyRight) + 1 }, (_, k) =>
    Math.exp(
      Array.from({ length: k }, (__, index) => Math.log((n - index) / (index + 1))).reduce(
        (total, value) => total + value,
        0,
      ) -
        n * Math.LN2,
    ),
  ).reduce((total, value) => total + value, 0);
  return { pValue: Math.min(1, 2 * tail) };
};

export const passAtK = (n: number, correct: number, k: number) => {
  if (n - correct < k) {
    return 1;
  }
  return (
    1 -
    Array.from({ length: correct }, (_, index) => 1 - k / (n - correct + 1 + index)).reduce(
      (total, value) => total * value,
      1,
    )
  );
};

export const passHatK = (n: number, correct: number, k: number) => {
  if (correct < k) {
    return 0;
  }
  return Array.from({ length: k }, (_, index) => (correct - index) / (n - index)).reduce(
    (total, value) => total * value,
    1,
  );
};
