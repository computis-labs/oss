import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Order from "effect/Order";
import { PdfPageError } from "#effect-pdf/errors/pdf-page-error";
import type { Pdfium } from "#effect-pdf/pdfium";
import { BYTES_PER_DOUBLE, readDoubles, readFloats } from "#effect-pdf/memory";

const ROW_TOLERANCE = 0.5;
const BASELINE_TOLERANCE = 0.1;
const WORD_GAP = 0.15;
const BACKSTEP = 0.2;
const MAX_GAP_SPACES = 4;
const OVERSTRIKE = 0.25;
const AXIS_EPSILON = 1e-3;
const GENERATED = 1;
const FIRST_PRINTABLE = 0x20;
const SPACE = 0x20;
const LINE_END_HYPHEN = 0x02;
const LINE_BREAKS: ReadonlySet<number> = new Set([0x0a, 0x0d]);
const ZERO_WIDTH = /^[\u200B-\u200D\u2060\uFEFF]$/u;
const RIGHT_TO_LEFT = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u;
const BLANK = /^\s*$/u;
const TRAILING_SPACE = /\s$/u;
const LEADING_SPACE = /^\s/u;

interface Run {
  readonly end: number;
  readonly horizontal: boolean;
  readonly lineBreakBefore: boolean;
  readonly size: number;
  readonly spaceBefore: boolean;
  readonly text: string;
  readonly x: number;
  readonly y: number;
}

const byX = Order.mapInput(Order.Number, (run: Run) => run.x);

export const charOrigin = (lib: Pdfium, textPage: number, index: number) =>
  readDoubles(lib, 2, (pointer) =>
    lib.FPDFText_GetCharOrigin(textPage, index, pointer, pointer + BYTES_PER_DOUBLE),
  );

export const layoutText = (
  lib: Pdfium,
  textPage: number,
  {
    count,
    page,
    stream,
  }: { readonly count: number; readonly page: number; readonly stream: string },
): Result.Result<string, PdfPageError> => {
  if (RIGHT_TO_LEFT.test(stream)) {
    return Result.succeed(stream.trim());
  }
  const codes = Array.from({ length: count }, (_, index) =>
    lib.FPDFText_GetUnicode(textPage, index),
  );
  const kept = codes.flatMap((code, index) =>
    lib.FPDFText_IsGenerated(textPage, index) === GENERATED ||
    (code < FIRST_PRINTABLE && code !== LINE_END_HYPHEN) ||
    ZERO_WIDTH.test(String.fromCodePoint(code))
      ? []
      : [index],
  );
  const measured = kept.flatMap((index, position) => {
    const origin = charOrigin(lib, textPage, index);
    const box = readFloats(lib, 4, (pointer) =>
      lib.FPDFText_GetLooseCharBox(textPage, index, pointer),
    );
    const matrix = readFloats(lib, 6, (pointer) =>
      lib.FPDFText_GetMatrix(textPage, index, pointer),
    );
    const skipped = codes.slice(position === 0 ? 0 : (kept[position - 1] ?? 0) + 1, index);
    return origin === null || box === null || matrix === null
      ? []
      : [{ box, code: codes[index] ?? SPACE, index, matrix, origin, skipped }];
  });
  if (measured.length < kept.length) {
    return Result.fail(PdfPageError.unmeasurable(page));
  }
  const glyphs = measured.map(({ box, code, index, matrix, origin, skipped }): Run => {
    const [x = 0, y = 0] = origin;
    const [left = x, top = y, right = x, bottom = y] = box;
    const [a = 1, b = 0, c = 0, d = 1] = matrix;
    const size = lib.FPDFText_GetFontSize(textPage, index) * Math.hypot(c, d);
    return {
      end: right,
      horizontal: a > 0 && d > 0 && Math.abs(b) < AXIS_EPSILON && Math.abs(c) < AXIS_EPSILON,
      lineBreakBefore: skipped.some((skippedCode) => LINE_BREAKS.has(skippedCode)),
      size: size > 0 ? size : top - bottom,
      spaceBefore: skipped.includes(SPACE),
      text: code === LINE_END_HYPHEN ? "-" : String.fromCodePoint(code),
      x: left,
      y,
    };
  });

  const grouped = Arr.reduce(
    glyphs,
    { closed: Arr.empty<Run>(), open: Option.none<Run>() },
    ({ closed, open }, glyph) => {
      if (Option.isNone(open)) {
        return { closed, open: Option.some(glyph) };
      }
      const run = open.value;
      const size = Math.min(run.size, glyph.size);
      const gap = glyph.x - run.end;
      const continues =
        !glyph.lineBreakBefore &&
        run.horizontal &&
        glyph.horizontal &&
        Math.abs(glyph.y - run.y) <= BASELINE_TOLERANCE * size &&
        gap >= -BACKSTEP * size &&
        gap <= WORD_GAP * size;
      return continues
        ? {
            closed,
            open: Option.some({
              ...run,
              end: Math.max(run.end, glyph.end),
              size,
              text: run.text + (glyph.spaceBefore ? " " : "") + glyph.text,
            }),
          }
        : { closed: [...closed, run], open: Option.some(glyph) };
    },
  );
  const runs = [...grouped.closed, ...Option.toArray(grouped.open)];

  const noRows: readonly { readonly anchor: Run; readonly runs: Arr.NonEmptyArray<Run> }[] = [];
  const rows = Arr.reduce(
    runs
      .filter(({ horizontal, text }) => horizontal && !BLANK.test(text))
      .toSorted((upper, lower) => lower.y - upper.y),
    noRows,
    (found, run) => {
      const index = found.findIndex(
        ({ anchor }) =>
          Math.abs(anchor.y - run.y) <= ROW_TOLERANCE * Math.min(anchor.size, run.size),
      );
      return index === -1
        ? [...found, { anchor: run, runs: Arr.of(run) }]
        : found.map((row, position) =>
            position === index ? { ...row, runs: Arr.append(row.runs, run) } : row,
          );
    },
  );

  const lines = rows.map(({ runs: cells }) => {
    const [first, ...rest] = Arr.sort(cells, byX);
    return Arr.reduce(rest, { line: first.text, previous: first }, ({ line, previous }, run) => {
      const size = Math.min(previous.size, run.size);
      if (run.text === previous.text && Math.abs(run.x - previous.x) < OVERSTRIKE * size) {
        return { line, previous };
      }
      const gap = run.x - previous.end;
      const separated =
        !TRAILING_SPACE.test(previous.text) &&
        !LEADING_SPACE.test(run.text) &&
        gap > WORD_GAP * size;
      const separator = separated
        ? " ".repeat(Math.min(MAX_GAP_SPACES, Math.max(1, Math.round(gap / size))))
        : "";
      return {
        line: line + separator + run.text,
        previous: run.end > previous.end ? run : { ...run, end: previous.end },
      };
    }).line.trimEnd();
  });
  const turned = runs
    .filter(({ horizontal }) => !horizontal)
    .map(({ lineBreakBefore, text }, index) => (lineBreakBefore && index > 0 ? `\n${text}` : text))
    .join("")
    .trim();
  return Result.succeed(
    [...lines, turned]
      .filter((line) => line.length > 0)
      .join("\n")
      .trim(),
  );
};
