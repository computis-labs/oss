import * as Match from "effect/Match";
import type { Pdfium } from "./pdfium.ts";
import { bitmapFormats, withAllocation } from "./memory.ts";
import type { PageObject } from "./objects.ts";
import { bgrToRgb, packBilevel, pngScanlines } from "./png.ts";
import type { PdfImageDraft, Raster } from "./png.ts";
import { pdfImageMediaTypes, pdfImageOrigins } from "./types.ts";

const JPEG_FILTER = "DCTDecode";
const PASSTHROUGH_COLORSPACES: ReadonlySet<number> = new Set([1, 2, 4, 5, 7]);
const PASSTHROUGH_COMPONENTS: ReadonlySet<number> = new Set([1, 3]);
const JPEG_MARKER = 0xff;
const JPEG_FRAME_MARKERS: ReadonlySet<number> = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
const JPEG_FIRST_SEGMENT = 2;
const JPEG_COMPONENTS_OFFSET = 9;

export interface PlacedImage extends PageObject {
  readonly bitsPerPixel: number;
  readonly colorspace: number;
  readonly height: number;
  readonly width: number;
}

export const embeddedImage = (lib: Pdfium, image: PlacedImage): PdfImageDraft | undefined => {
  const filters = Array.from(
    { length: lib.FPDFImageObj_GetImageFilterCount(image.pointer) },
    (_, index) => {
      const size = lib.FPDFImageObj_GetImageFilter(image.pointer, index, 0, 0);
      return withAllocation(lib, size, (buffer) => {
        lib.FPDFImageObj_GetImageFilter(image.pointer, index, buffer, size);
        return lib.pdfium.UTF8ToString(buffer);
      });
    },
  );
  const rawSize =
    filters.length === 1 &&
    filters[0] === JPEG_FILTER &&
    PASSTHROUGH_COLORSPACES.has(image.colorspace)
      ? lib.FPDFImageObj_GetImageDataRaw(image.pointer, 0, 0)
      : 0;
  const jpeg = withAllocation(lib, rawSize, (buffer) => {
    lib.FPDFImageObj_GetImageDataRaw(image.pointer, buffer, rawSize);
    return lib.pdfium.HEAPU8.slice(buffer, buffer + rawSize);
  });
  const frameComponents = (): number | null => {
    for (
      let position = JPEG_FIRST_SEGMENT;
      position + JPEG_COMPONENTS_OFFSET < jpeg.length && jpeg[position] === JPEG_MARKER;
      position += 2 + (jpeg[position + 2] ?? 0) * 256 + (jpeg[position + 3] ?? 0)
    ) {
      if (JPEG_FRAME_MARKERS.has(jpeg[position + 1] ?? 0)) {
        return jpeg[position + JPEG_COMPONENTS_OFFSET] ?? null;
      }
    }
    return null;
  };
  if (rawSize > 0 && PASSTHROUGH_COMPONENTS.has(frameComponents() ?? 0)) {
    return {
      bytes: jpeg,
      height: image.height,
      mediaType: pdfImageMediaTypes.jpeg,
      origin: pdfImageOrigins.embedded,
      width: image.width,
    };
  }
  const bitmap = lib.FPDFImageObj_GetBitmap(image.pointer);
  if (bitmap === 0) {
    return undefined;
  }
  try {
    const width = lib.FPDFBitmap_GetWidth(bitmap);
    const height = lib.FPDFBitmap_GetHeight(bitmap);
    const stride = lib.FPDFBitmap_GetStride(bitmap);
    const format = lib.FPDFBitmap_GetFormat(bitmap);
    const start = lib.FPDFBitmap_GetBuffer(bitmap);
    const heap = lib.pdfium.HEAPU8;
    const raster = Match.value({
      bilevel: image.bitsPerPixel === 1,
      gray: format === bitmapFormats.gray,
    }).pipe(
      Match.when({ bilevel: true, gray: true }, () =>
        packBilevel(heap, { height, start, stride, width }),
      ),
      Match.when({ gray: true }, (): Raster => ({
        bitDepth: 8,
        channels: 1,
        data: heap.slice(start, start + stride * height),
        height,
        rowBytes: stride,
        width,
      })),
      Match.orElse(() =>
        bgrToRgb(
          heap,
          {
            height,
            sourceChannels: format === bitmapFormats.bgr ? 3 : 4,
            start,
            stride,
            width,
          },
          format === bitmapFormats.bgra ? 4 : 3,
        ),
      ),
    );
    return {
      height,
      mediaType: pdfImageMediaTypes.png,
      origin: pdfImageOrigins.embedded,
      png: pngScanlines(raster),
      width,
    };
  } finally {
    lib.FPDFBitmap_Destroy(bitmap);
  }
};
