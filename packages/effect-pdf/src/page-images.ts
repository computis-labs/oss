import * as Result from "effect/Result";
import { embeddedImage } from "#effect-pdf/embedded-image";
import type { PlacedImage } from "#effect-pdf/embedded-image";
import { PdfPageError } from "#effect-pdf/errors/pdf-page-error";
import { withFormEnvironment, withFormPage } from "#effect-pdf/handle";
import { withAllocation } from "#effect-pdf/memory";
import type { PdfHandle } from "#effect-pdf/handle";
import { areaOf, overlapArea, pageBox, pageObjects, pageObjectTypes } from "#effect-pdf/objects";
import { MAX_RENDER_PIXELS, renderPng, renderedSize } from "#effect-pdf/render";

export const DEFAULT_PAGE_IMAGE_DPI = 200;

const DOMINANT_PIXEL_SHARE = 0.8;
const SCAN_COVERAGE = 0.5;
const METADATA_BYTES = 28;
const BYTES_PER_WORD = 4;
const COLORSPACE_UNKNOWN = 0;
const VISIBLE_OVERLAYS: ReadonlySet<number> = new Set([
  pageObjectTypes.path,
  pageObjectTypes.shading,
]);

const pixelsOf = (image: PlacedImage) => image.width * image.height;

const isMask = (image: PlacedImage) =>
  image.bitsPerPixel === 1 && image.colorspace === COLORSPACE_UNKNOWN;

export const pageImage = (handle: PdfHandle, page: number, dpi: number) =>
  withFormEnvironment(handle, (form) =>
    withFormPage(handle, form, page, (pagePointer) => {
      const { lib } = handle;
      const placed = pageObjects(lib, pagePointer, page);
      if (Result.isFailure(placed)) {
        return Result.fail(placed.failure);
      }
      const objects = placed.success;
      const box = pageBox(lib, pagePointer);
      const read = withAllocation(lib, METADATA_BYTES, (metadata) =>
        Result.all(
          objects
            .filter((object) => object.type === pageObjectTypes.image)
            .map((object): Result.Result<PlacedImage, PdfPageError> => {
              if (!lib.FPDFImageObj_GetImageMetadata(object.pointer, pagePointer, metadata)) {
                return Result.fail(PdfPageError.unreadableImage(page));
              }
              const word = metadata / BYTES_PER_WORD;
              return Result.succeed({
                ...object,
                bitsPerPixel: lib.pdfium.HEAPU32[word + 4] ?? 0,
                colorspace: lib.pdfium.HEAP32[word + 5] ?? 0,
                height: lib.pdfium.HEAPU32[word + 1] ?? 0,
                width: lib.pdfium.HEAPU32[word] ?? 0,
              });
            }),
        ),
      );
      if (Result.isFailure(read)) {
        return Result.fail(read.failure);
      }
      const images = read.success;
      const masked = images.some(isMask);
      const pictures = images.filter((image) => !isMask(image));
      const [largest] = pictures.toSorted((left, right) => pixelsOf(right) - pixelsOf(left));
      const overlaid = objects.some(
        (object) =>
          VISIBLE_OVERLAYS.has(object.type) ||
          (object.type === pageObjectTypes.text && !object.invisibleText),
      );
      const scan =
        largest !== undefined &&
        !masked &&
        !overlaid &&
        pixelsOf(largest) >=
          DOMINANT_PIXEL_SHARE * pictures.reduce((total, image) => total + pixelsOf(image), 0) &&
        overlapArea(largest.bounds, box) >= SCAN_COVERAGE * areaOf(box)
          ? embeddedImage(lib, largest)
          : undefined;
      if (scan !== undefined) {
        return Result.succeed(scan);
      }
      const size = renderedSize(lib, pagePointer, { dpi });
      const shrink = Math.min(1, Math.sqrt(MAX_RENDER_PIXELS / (size.width * size.height)));
      return Result.succeed(
        renderPng(lib, form, pagePointer, {
          height: Math.max(1, Math.floor(size.height * shrink)),
          width: Math.max(1, Math.floor(size.width * shrink)),
        }),
      );
    }),
  );
