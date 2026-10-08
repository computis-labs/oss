import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { decode } from "fast-png";
import { pdfEngineLayer } from "./fixtures/layer.ts";
import {
  COLOR_SCAN_PIXELS,
  PAGE,
  SCAN,
  bilevelRows,
  bilevelScanPdf,
  cmykJpegScanPdf,
  colorScanPdf,
  formPdf,
  jpegScanPdf,
  mrcScanPdf,
  ocrScanPdf,
  redPagePdf,
  scanJpeg,
  stampedScanPdf,
  textPdf,
} from "./fixtures/pdfs.ts";
import { PdfPageError } from "#effect-pdf/errors/pdf-page-error";
import { open } from "#effect-pdf/index";
import { pdfImageMediaTypes, pdfImageOrigins } from "#effect-pdf/types";

const darkShare = (png: Uint8Array) => {
  const { channels, data } = decode(png);
  const pixels = data.length / channels;
  const dark = Array.from({ length: pixels }, (_, pixel) => data[pixel * channels] ?? 255).filter(
    (value) => value < 128,
  ).length;
  return dark / pixels;
};

layer(pdfEngineLayer)("pageImages", (it) => {
  it.effect("hands a JPEG scan over unchanged", () =>
    Effect.gen(function* () {
      const document = yield* open(yield* jpegScanPdf);
      const jpeg = yield* scanJpeg;

      const [image] = yield* document.pageImages();

      expect(image).toStrictEqual({
        bytes: jpeg,
        height: 594,
        mediaType: pdfImageMediaTypes.jpeg,
        origin: pdfImageOrigins.embedded,
        width: 420,
      });
    }),
  );

  it.effect("decodes a CMYK JPEG to RGB instead of handing it over", () =>
    Effect.gen(function* () {
      const document = yield* open(yield* cmykJpegScanPdf);

      const [image] = yield* document.pageImages();

      expect(image).toMatchObject({
        height: 64,
        mediaType: pdfImageMediaTypes.png,
        origin: pdfImageOrigins.embedded,
        width: 64,
      });
      const { channels, data, width } = decode(image?.bytes ?? new Uint8Array());
      const pixel = (x: number, y: number) => [
        ...data.subarray((y * width + x) * channels, (y * width + x) * channels + 3),
      ];
      expect(pixel(8, 32)).toSatisfy(
        ([red = 0, green = 0, blue = 0]: number[]) => red > 200 && green < 60 && blue < 60,
      );
      expect(pixel(56, 32)).toSatisfy(
        ([red = 0, green = 0, blue = 0]: number[]) => blue > red + 60 && blue > green + 40,
      );
    }),
  );

  it.effect("turns PDFium's BGR pixels of an embedded colour image into RGB", () =>
    Effect.gen(function* () {
      const document = yield* open(colorScanPdf());

      const [image] = yield* document.pageImages();

      const decoded = decode(image?.bytes ?? new Uint8Array());
      expect([decoded.channels, [...decoded.data]]).toStrictEqual([3, COLOR_SCAN_PIXELS.flat()]);
    }),
  );

  it.effect.each([
    ["bilevel scan", bilevelScanPdf],
    ["scan under a hidden OCR layer", ocrScanPdf],
  ] as const)("encodes a %s as a 1-bit PNG with the scanned pixels", ([, build]) =>
    Effect.gen(function* () {
      const document = yield* open(build());

      const [image] = yield* document.pageImages();

      expect(image).toMatchObject({
        height: SCAN.height,
        mediaType: pdfImageMediaTypes.png,
        origin: pdfImageOrigins.embedded,
        width: SCAN.width,
      });
      const decoded = decode(image?.bytes ?? new Uint8Array());
      expect(decoded.depth).toBe(1);
      expect(decoded.data).toStrictEqual(bilevelRows);
    }),
  );

  it.effect("renders a scan split in layers, so the text drawn by its mask reaches the image", () =>
    Effect.gen(function* () {
      const document = yield* open(mrcScanPdf());

      const [image] = yield* document.pageImages({ dpi: 72 });

      expect(image).toMatchObject({
        height: PAGE.height,
        mediaType: pdfImageMediaTypes.png,
        origin: pdfImageOrigins.rendered,
        width: PAGE.width,
      });
      expect(darkShare(image?.bytes ?? new Uint8Array())).toBeGreaterThan(0.1);
    }),
  );

  it.effect.each([
    ["scan with a visible stamp", Effect.succeed(stampedScanPdf())],
    ["text page", textPdf([["Fattura"]])],
  ] as const)("renders a %s at the requested resolution", ([, bytes]) =>
    Effect.gen(function* () {
      const document = yield* open(yield* bytes);

      const [image] = yield* document.pageImages({ dpi: 144 });

      expect(image).toMatchObject({
        height: PAGE.height * 2,
        origin: pdfImageOrigins.rendered,
        width: PAGE.width * 2,
      });
    }),
  );
});

const darkInBox = (
  png: Uint8Array,
  box: {
    readonly height: number;
    readonly left: number;
    readonly top: number;
    readonly width: number;
  },
) => {
  const { channels, data, width } = decode(png);
  return Array.from({ length: box.width * box.height }, (_, index) => {
    const x = box.left + (index % box.width);
    const y = box.top + Math.floor(index / box.width);
    return data[(y * width + x) * channels] ?? 255;
  }).filter((value) => value < 128).length;
};

const CHECKBOX_BOX = { height: 12, left: 50, top: PAGE.height - 672, width: 12 } as const;
const COMPANY_BOX = { height: 20, left: 50, top: PAGE.height - 720, width: 240 } as const;

layer(pdfEngineLayer)("render", (it) => {
  it.effect("draws form fields with the values written to them", () =>
    Effect.gen(function* () {
      const document = yield* open(yield* formPdf);
      const before = yield* document.render(0, { dpi: 72 });

      yield* document.setFields({ privacy: true, ragioneSociale: "WWWWWWWWWWWWWWWWWWWW" });
      const after = yield* document.render(0, { dpi: 72 });

      expect(darkInBox(before.bytes, COMPANY_BOX)).toBeGreaterThan(0);
      expect(darkInBox(after.bytes, CHECKBOX_BOX)).toBeGreaterThan(
        darkInBox(before.bytes, CHECKBOX_BOX),
      );
      expect(darkInBox(after.bytes, COMPANY_BOX)).toBeGreaterThan(
        darkInBox(before.bytes, COMPANY_BOX),
      );
    }),
  );

  it.effect("renders a page to an RGB PNG of the requested width", () =>
    Effect.gen(function* () {
      const document = yield* open(yield* textPdf([["Fattura n. 7"]]));

      const image = yield* document.render(0, { width: 900 });

      const decoded = decode(image.bytes);
      expect([decoded.width, decoded.height, decoded.channels]).toStrictEqual([
        900,
        Math.round((PAGE.height / PAGE.width) * 900),
        3,
      ]);
      expect(darkShare(image.bytes)).toBeGreaterThan(0);
    }),
  );

  it.effect("renders colours in RGB order", () =>
    Effect.gen(function* () {
      const document = yield* open(redPagePdf());

      const image = yield* document.render(0, { width: 20 });

      const { channels, data } = decode(image.bytes);
      expect([...data.subarray(0, channels)]).toStrictEqual([255, 0, 0]);
    }),
  );

  it.effect("refuses a render larger than the pixel limit", () =>
    Effect.gen(function* () {
      const document = yield* open(bilevelScanPdf());

      const error = yield* Effect.flip(document.render(0, { width: 20_000 }));

      expect(error).toBeInstanceOf(PdfPageError);
    }),
  );
});
