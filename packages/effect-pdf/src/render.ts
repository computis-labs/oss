import * as Result from "effect/Result";
import type { Pdfium } from "#effect-pdf/pdfium";
import { PdfPageError } from "#effect-pdf/errors/pdf-page-error";
import { withFormEnvironment, withFormPage } from "#effect-pdf/handle";
import type { PdfHandle } from "#effect-pdf/handle";
import { bitmapFormats } from "#effect-pdf/memory";
import { encodePng } from "#effect-pdf/png";
import { pdfImageMediaTypes, pdfImageOrigins } from "#effect-pdf/types";
import type { PdfImage, PdfRenderSize } from "#effect-pdf/types";

export const MAX_RENDER_PIXELS = 40_000_000;

const DEFAULT_RENDER_DPI = 150;
const POINTS_PER_INCH = 72;
const RENDER_ANNOTATIONS = 0x01;
const REVERSE_BYTE_ORDER = 0x10;
const RENDER_FLAGS = RENDER_ANNOTATIONS + REVERSE_BYTE_ORDER;
const WHITE = 0xff_ff_ff_ff;
const RGB_CHANNELS = 3;

export const renderedSize = (lib: Pdfium, pagePointer: number, { dpi, width }: PdfRenderSize) => {
  const pageWidth = lib.FPDF_GetPageWidthF(pagePointer);
  const pageHeight = lib.FPDF_GetPageHeightF(pagePointer);
  const pixelWidth = Math.max(
    1,
    Math.round(width ?? (pageWidth / POINTS_PER_INCH) * (dpi ?? DEFAULT_RENDER_DPI)),
  );
  return {
    height: Math.max(1, Math.round((pageHeight / pageWidth) * pixelWidth)),
    width: pixelWidth,
  };
};

export const renderPng = (
  lib: Pdfium,
  form: number,
  pagePointer: number,
  { height, width }: { readonly height: number; readonly width: number },
): PdfImage => {
  const rowBytes = width * RGB_CHANNELS;
  const bitmap = lib.FPDFBitmap_CreateEx(width, height, bitmapFormats.bgr, 0, rowBytes);
  try {
    lib.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, WHITE);
    lib.FPDF_RenderPageBitmap(bitmap, pagePointer, 0, 0, width, height, 0, RENDER_FLAGS);
    lib.FPDF_SetFormFieldHighlightAlpha(form, 0);
    lib.FPDF_FFLDraw(form, bitmap, pagePointer, 0, 0, width, height, 0, RENDER_FLAGS);
    const pixels = lib.FPDFBitmap_GetBuffer(bitmap);
    const stride = lib.FPDFBitmap_GetStride(bitmap);
    return {
      bytes: encodePng({
        bitDepth: 8,
        channels: RGB_CHANNELS,
        data: lib.pdfium.HEAPU8.subarray(pixels, pixels + stride * height),
        height,
        rowBytes: stride,
        width,
      }),
      height,
      mediaType: pdfImageMediaTypes.png,
      origin: pdfImageOrigins.rendered,
      width,
    };
  } finally {
    lib.FPDFBitmap_Destroy(bitmap);
  }
};

export const renderPage = (handle: PdfHandle, page: number, size: PdfRenderSize) =>
  withFormEnvironment(handle, (form) =>
    withFormPage(handle, form, page, (pagePointer) => {
      const pixels = renderedSize(handle.lib, pagePointer, size);
      return pixels.width * pixels.height > MAX_RENDER_PIXELS
        ? Result.fail(
            new PdfPageError({
              message: `Rendering page ${page.toString()} at ${pixels.width.toString()}×${pixels.height.toString()} exceeds ${MAX_RENDER_PIXELS.toString()} pixels.`,
              page,
            }),
          )
        : Result.succeed(renderPng(handle.lib, form, pagePointer, pixels));
    }),
  );
