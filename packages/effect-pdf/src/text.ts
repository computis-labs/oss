import * as Result from "effect/Result";
import type { Pdfium } from "#effect-pdf/pdfium";
import { PdfPageError } from "#effect-pdf/errors/pdf-page-error";
import { withPage } from "#effect-pdf/handle";
import type { PdfHandle } from "#effect-pdf/handle";
import { BYTES_PER_UTF16_UNIT, readDoubles, withAllocation } from "#effect-pdf/memory";
import { charOrigin, layoutText } from "#effect-pdf/text-layout";
import { rectBetween } from "#effect-pdf/objects";
import type { PdfPageText, PdfTextMatch } from "#effect-pdf/types";

const CARRIAGE_RETURNS = /\r\n?/gu;
const GENERATED = 1;
const UNMAPPED = 1;

const withTextPage = <A>(
  handle: PdfHandle,
  page: number,
  read: (
    lib: Pdfium,
    textPage: number,
    page: { readonly count: number; readonly characters: string },
  ) => Result.Result<A, PdfPageError>,
) =>
  withPage(handle, page, (pagePointer) => {
    const { lib } = handle;
    const textPage = lib.FPDFText_LoadPage(pagePointer);
    try {
      const count = Math.max(0, lib.FPDFText_CountChars(textPage));
      const characters =
        count === 0
          ? ""
          : withAllocation(lib, (count + 1) * BYTES_PER_UTF16_UNIT, (buffer) => {
              lib.FPDFText_GetText(textPage, 0, count, buffer);
              return lib.pdfium.UTF16ToString(buffer);
            });
      return read(lib, textPage, { characters, count });
    } finally {
      lib.FPDFText_ClosePage(textPage);
    }
  });

export const pageText = (handle: PdfHandle, page: number, layout: boolean) =>
  withTextPage(handle, page, (lib, textPage, { characters, count }) =>
    Result.map((text: string): PdfPageText => ({
      page,
      text,
      unicodeMapErrors: Array.from({ length: count }, (_, index) =>
        lib.FPDFText_HasUnicodeMapError(textPage, index),
      ).filter((flag) => flag === UNMAPPED).length,
    }))(
      layout
        ? layoutText(lib, textPage, { count, page, stream: characters })
        : Result.succeed(characters.replaceAll(CARRIAGE_RETURNS, "\n")),
    ),
  );

export const pageMatches = (handle: PdfHandle, page: number, pattern: RegExp) =>
  withTextPage(handle, page, (lib, textPage, { characters }) => {
    const global = new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
    );
    const matches = Array.from(characters.matchAll(global), (match): PdfTextMatch | null => {
      const glyphs = Array.from({ length: match[0].length }, (_, offset) =>
        lib.FPDFText_GetCharIndexFromTextIndex(textPage, match.index + offset),
      ).filter(
        (index, position, all) =>
          index >= 0 &&
          all.indexOf(index) === position &&
          lib.FPDFText_IsGenerated(textPage, index) !== GENERATED,
      );
      const boxes = glyphs.map((index) =>
        readDoubles(lib, 4, (box) =>
          lib.FPDFText_GetCharBox(textPage, index, box, box + 8, box + 16, box + 24),
        ),
      );
      const measured = boxes.flatMap((box) => (box === null ? [] : [box]));
      const [first] = glyphs;
      const origin = first === undefined ? null : charOrigin(lib, textPage, first);
      return origin === null || measured.length === 0 || measured.length < boxes.length
        ? null
        : {
            box: rectBetween(
              Math.min(...measured.map((edges) => edges[0] ?? 0)),
              Math.min(...measured.map((edges) => edges[2] ?? 0)),
              Math.max(...measured.map((edges) => edges[1] ?? 0)),
              Math.max(...measured.map((edges) => edges[3] ?? 0)),
            ),
            groups: { ...match.groups },
            origin: { x: origin[0] ?? 0, y: origin[1] ?? 0 },
            page,
            text: match[0],
          };
    });
    const placed = matches.flatMap((match) => (match === null ? [] : [match]));
    return placed.length === matches.length
      ? Result.succeed(placed)
      : Result.fail(PdfPageError.unmeasurable(page));
  });
