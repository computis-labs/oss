import * as Effect from "effect/Effect";
import { PdfEngineError } from "./errors/pdf-engine-error.ts";
import type { PdfImage } from "./types.ts";

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const COLOR_TYPES = { 1: 0, 3: 2, 4: 6 } as const satisfies Record<RasterChannels, number>;
const BITS_PER_BYTE = 8;
const INK_THRESHOLD = 128;
const BIT_WEIGHTS = [128, 64, 32, 16, 8, 4, 2, 1] as const;
const HEADER_BYTES = 13;
const CHUNK_OVERHEAD = 12;
const CRC_POLYNOMIAL = 0xed_b8_83_20;
const CRC_INITIAL = 0xff_ff_ff_ff;
const BYTE_VALUES = 256;
const BYTE_MASK = 0xff;

const ascii = new TextEncoder();

const CRC_TABLE = Uint32Array.from({ length: BYTE_VALUES }, (_, byte) => {
  const round = (crc: number, bits: number): number =>
    bits === 0
      ? crc
      : // oxlint-disable-next-line no-bitwise -- CRC-32 is defined on bits
        round(crc & 1 ? CRC_POLYNOMIAL ^ (crc >>> 1) : crc >>> 1, bits - 1);
  return round(byte, BITS_PER_BYTE);
});

export type RasterChannels = 1 | 3 | 4;

export interface Raster {
  readonly bitDepth: 1 | 8;
  readonly channels: RasterChannels;
  readonly data: Uint8Array;
  readonly height: number;
  readonly rowBytes: number;
  readonly width: number;
}

export interface PngScanlines {
  readonly header: Uint8Array;
  readonly scanlines: Uint8Array<ArrayBuffer>;
}

export type PdfImageDraft = PdfImage | (Omit<PdfImage, "bytes"> & { readonly png: PngScanlines });

const chunk = (type: string, data: Uint8Array) => {
  const out = new Uint8Array(CHUNK_OVERHEAD + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(ascii.encode(type), 4);
  out.set(data, 8);
  const crc = out.subarray(4, 8 + data.length).reduce(
    // oxlint-disable-next-line no-bitwise -- CRC-32 is defined on bits
    (current, byte) => (CRC_TABLE[(current ^ byte) & BYTE_MASK] ?? 0) ^ (current >>> BITS_PER_BYTE),
    CRC_INITIAL,
  );
  // oxlint-disable-next-line no-bitwise -- CRC-32 is defined on bits
  view.setUint32(8 + data.length, (crc ^ CRC_INITIAL) >>> 0);
  return out;
};

export const packBilevel = (
  heap: Uint8Array,
  {
    height,
    start,
    stride,
    width,
  }: Pick<Raster, "height" | "width"> & {
    readonly start: number;
    readonly stride: number;
  },
): Raster => {
  const rowBytes = Math.ceil(width / BITS_PER_BYTE);
  const whole = Math.floor(width / BITS_PER_BYTE);
  const lit = (at: number, weight: number) => ((heap[at] ?? 0) >= INK_THRESHOLD ? weight : 0);
  const data = new Uint8Array(rowBytes * height);
  for (let row = 0; row < height; row += 1) {
    const source = start + row * stride;
    const target = row * rowBytes;
    for (let column = 0; column < whole; column += 1) {
      const at = source + column * BITS_PER_BYTE;
      data[target + column] =
        lit(at, 128) +
        lit(at + 1, 64) +
        lit(at + 2, 32) +
        lit(at + 3, 16) +
        lit(at + 4, 8) +
        lit(at + 5, 4) +
        lit(at + 6, 2) +
        lit(at + 7, 1);
    }
    if (width > whole * BITS_PER_BYTE) {
      data[target + whole] = BIT_WEIGHTS.slice(0, width - whole * BITS_PER_BYTE).reduce(
        (byte, weight, bit) => byte + lit(source + whole * BITS_PER_BYTE + bit, weight),
        0,
      );
    }
  }
  return { bitDepth: 1, channels: 1, data, height, rowBytes, width };
};

export const bgrToRgb = (
  heap: Uint8Array,
  {
    height,
    sourceChannels,
    start,
    stride,
    width,
  }: Pick<Raster, "height" | "width"> & {
    readonly sourceChannels: 3 | 4;
    readonly start: number;
    readonly stride: number;
  },
  channels: 3 | 4,
): Raster => {
  const rowBytes = width * channels;
  const data = new Uint8Array(rowBytes * height);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const from = start + row * stride + column * sourceChannels;
      const to = row * rowBytes + column * channels;
      data[to] = heap[from + 2] ?? 0;
      data[to + 1] = heap[from + 1] ?? 0;
      data[to + 2] = heap[from] ?? 0;
      if (channels === 4) {
        data[to + 3] = heap[from + 3] ?? 0;
      }
    }
  }
  return { bitDepth: 8, channels, data, height, rowBytes, width };
};

export const pngScanlines = ({
  bitDepth,
  channels,
  data,
  height,
  rowBytes,
  width,
}: Raster): PngScanlines => {
  const header = new Uint8Array(HEADER_BYTES);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  view.setUint8(8, bitDepth);
  view.setUint8(9, COLOR_TYPES[channels]);
  const lineBytes = Math.ceil((width * channels * bitDepth) / BITS_PER_BYTE);
  const scanlines = new Uint8Array((lineBytes + 1) * height);
  for (let row = 0; row < height; row += 1) {
    scanlines.set(
      data.subarray(row * rowBytes, row * rowBytes + lineBytes),
      row * (lineBytes + 1) + 1,
    );
  }
  return { header, scanlines };
};

export const encodePng = Effect.fn("EffectPdf.encodePng")(function* encodePng({
  header,
  scanlines,
}: PngScanlines) {
  const compressed = yield* Effect.tryPromise({
    catch: (cause) => new PdfEngineError({ cause, message: "The PNG could not be compressed." }),
    try: async () => {
      const compression = new CompressionStream("deflate");
      const writer = compression.writable.getWriter();
      const [, deflated] = await Promise.all([
        writer.write(scanlines).then(async () => {
          await writer.close();
        }),
        new Response(compression.readable).arrayBuffer(),
      ]);
      return new Uint8Array(deflated);
    },
  });
  const ihdr = chunk("IHDR", header);
  const idat = chunk("IDAT", compressed);
  const iend = chunk("IEND", new Uint8Array(0));
  const png = new Uint8Array(SIGNATURE.length + ihdr.length + idat.length + iend.length);
  png.set(SIGNATURE, 0);
  png.set(ihdr, SIGNATURE.length);
  png.set(idat, SIGNATURE.length + ihdr.length);
  png.set(iend, png.length - iend.length);
  return png;
});

export const finishImage = Effect.fn("EffectPdf.finishImage")(function* finishImage(
  draft: PdfImageDraft,
): Effect.fn.Return<PdfImage, PdfEngineError> {
  if ("bytes" in draft) {
    return draft;
  }
  const { height, mediaType, origin, png, width } = draft;
  return { bytes: yield* encodePng(png), height, mediaType, origin, width };
});
