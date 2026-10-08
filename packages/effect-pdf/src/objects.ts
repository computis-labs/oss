import * as Result from "effect/Result";
import type { Pdfium } from "./pdfium.ts";
import { PdfPageError } from "./errors/pdf-page-error.ts";
import { readFloats } from "./memory.ts";
import type { PdfRect } from "./types.ts";

export const pageObjectTypes = {
  form: 5,
  image: 3,
  path: 2,
  shading: 4,
  text: 1,
  unknown: 0,
} as const;
export type PageObjectType = (typeof pageObjectTypes)[keyof typeof pageObjectTypes];

const pageObjectTypeCodes: ReadonlyMap<number, PageObjectType> = new Map(
  Object.values(pageObjectTypes).map((type) => [type, type]),
);
const INVISIBLE_TEXT_MODES: ReadonlySet<number> = new Set([3, 7]);

type Matrix = readonly [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export interface PageObject {
  readonly bounds: PdfRect;
  readonly invisibleText: boolean;
  readonly pointer: number;
  readonly type: PageObjectType;
}

export const rectBetween = (x1: number, y1: number, x2: number, y2: number): PdfRect => ({
  bottom: Math.min(y1, y2),
  left: Math.min(x1, x2),
  right: Math.max(x1, x2),
  top: Math.max(y1, y2),
});

const placedCorner = (placement: Matrix, x: number, y: number) =>
  [
    placement[0] * x + placement[2] * y + placement[4],
    placement[1] * x + placement[3] * y + placement[5],
  ] as const;

export const pageObjects = (
  lib: Pdfium,
  pagePointer: number,
  page: number,
): Result.Result<readonly PageObject[], PdfPageError> => {
  const visit = (pointer: number, placement: Matrix): readonly (PageObject | null)[] => {
    const type =
      pageObjectTypeCodes.get(lib.FPDFPageObj_GetType(pointer)) ?? pageObjectTypes.unknown;
    if (type === pageObjectTypes.form) {
      const own = readFloats(lib, 6, (matrix) => lib.FPDFPageObj_GetMatrix(pointer, matrix));
      if (own === null) {
        return [null];
      }
      const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = own;
      const [pa, pb, pc, pd, pe, pf] = placement;
      const composed: Matrix = [
        a * pa + b * pc,
        a * pb + b * pd,
        c * pa + d * pc,
        c * pb + d * pd,
        e * pa + f * pc + pe,
        e * pb + f * pd + pf,
      ];
      return Array.from({ length: lib.FPDFFormObj_CountObjects(pointer) }, (_, index) =>
        visit(lib.FPDFFormObj_GetObject(pointer, index), composed),
      ).flat();
    }
    const bounds = readFloats(lib, 4, (box) =>
      lib.FPDFPageObj_GetBounds(pointer, box, box + 4, box + 8, box + 12),
    );
    if (bounds === null) {
      return [null];
    }
    const [left = 0, bottom = 0, right = 0, top = 0] = bounds;
    const corners = [
      placedCorner(placement, left, bottom),
      placedCorner(placement, right, bottom),
      placedCorner(placement, left, top),
      placedCorner(placement, right, top),
    ];
    const xs = corners.map(([x]) => x);
    const ys = corners.map(([, y]) => y);
    return [
      {
        bounds: rectBetween(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)),
        invisibleText:
          type === pageObjectTypes.text &&
          INVISIBLE_TEXT_MODES.has(lib.FPDFTextObj_GetTextRenderMode(pointer)),
        pointer,
        type,
      },
    ];
  };
  const visited = Array.from({ length: lib.FPDFPage_CountObjects(pagePointer) }, (_, index) =>
    visit(lib.FPDFPage_GetObject(pagePointer, index), IDENTITY),
  ).flat();
  const objects = visited.flatMap((object) => (object === null ? [] : [object]));
  return objects.length === visited.length
    ? Result.succeed(objects)
    : Result.fail(PdfPageError.unmeasurable(page));
};

export const pageBox = (lib: Pdfium, pagePointer: number): PdfRect => {
  const read = (getter: typeof lib.FPDFPage_GetCropBox) => {
    const box = readFloats(lib, 4, (pointer) =>
      getter(pagePointer, pointer, pointer + 4, pointer + 8, pointer + 12),
    );
    return box === null ? null : rectBetween(box[0] ?? 0, box[1] ?? 0, box[2] ?? 0, box[3] ?? 0);
  };
  return (
    read(lib.FPDFPage_GetCropBox) ??
    read(lib.FPDFPage_GetMediaBox) ??
    rectBetween(0, 0, lib.FPDF_GetPageWidthF(pagePointer), lib.FPDF_GetPageHeightF(pagePointer))
  );
};

export const overlapArea = (inner: PdfRect, outer: PdfRect) => {
  const width = Math.min(inner.right, outer.right) - Math.max(inner.left, outer.left);
  const height = Math.min(inner.top, outer.top) - Math.max(inner.bottom, outer.bottom);
  return width > 0 && height > 0 ? width * height : 0;
};

export const areaOf = ({ bottom, left, right, top }: PdfRect) => (right - left) * (top - bottom);
