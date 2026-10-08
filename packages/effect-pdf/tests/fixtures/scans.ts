import { deflateSync } from "node:zlib";
import { Effect, FileSystem, Path } from "effect";
import {
  A4,
  bilevelImage,
  bilevelScan,
  fullPage,
  onePagePdf,
  pdfStream,
} from "#effect-pdf/testing";

const readFixture = (name: string) =>
  Effect.gen(function* readFixtureFile() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const bytes = yield* fs.readFile(yield* path.fromFileUrl(new URL(name, import.meta.url)));
    return new Uint8Array(bytes);
  });

export const scanJpeg = readFixture("scan.jpg");

export const jpegScanPdf = scanJpeg.pipe(
  Effect.map((jpeg) =>
    onePagePdf(fullPage("Scan"), {
      Scan: pdfStream(
        "/Type /XObject /Subtype /Image /Width 420 /Height 594 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode",
        jpeg,
      ),
    }),
  ),
);

export const mrcScanPdf = () =>
  onePagePdf(`${fullPage("Background")}0 0 0 rg\n${fullPage("Ink")}`, {
    Background: pdfStream(
      `/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`,
      deflateSync(new Uint8Array(12).fill(0xfa)),
    ),
    Ink: pdfStream(
      `/Type /XObject /Subtype /Image /Width ${bilevelScan.width.toString()} /Height ${bilevelScan.height.toString()} /ImageMask true /BitsPerComponent 1 /Filter /FlateDecode`,
      deflateSync(bilevelScan.rows),
    ),
  });

export const logoInvoicePdf = () =>
  onePagePdf(
    "q 160 0 0 80 40 740 cm /Logo Do Q\nBT /F1 12 Tf 50 700 Td (Timbro visibile) Tj ET\n",
    { Logo: bilevelImage() },
  );

export const cmykJpegScanPdf = readFixture("scan-cmyk.jpg").pipe(
  Effect.map((jpeg) =>
    onePagePdf(fullPage("Scan"), {
      Scan: pdfStream(
        "/Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceCMYK /BitsPerComponent 8 /Decode [1 0 1 0 1 0 1 0] /Filter /DCTDecode",
        jpeg,
      ),
    }),
  ),
);

export const COLOR_SCAN_PIXELS = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 255],
] as const;

export const colorScanPdf = () =>
  onePagePdf(fullPage("Scan"), {
    Scan: pdfStream(
      "/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode",
      deflateSync(Uint8Array.from(COLOR_SCAN_PIXELS.flat())),
    ),
  });

export const redPagePdf = () =>
  onePagePdf(`1 0 0 rg 0 0 ${A4.width.toString()} ${A4.height.toString()} re f\n`, {});
