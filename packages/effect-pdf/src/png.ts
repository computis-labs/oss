import { crc32, deflateSync } from "node:zlib";

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const COLOR_TYPES = { 1: 0, 3: 2, 4: 6 } as const satisfies Record<RasterChannels, number>;
const COMPRESSION_LEVEL = 6;
const BITS_PER_BYTE = 8;
const INK_THRESHOLD = 128;
const BIT_WEIGHTS = [128, 64, 32, 16, 8, 4, 2, 1] as const;

export type RasterChannels = 1 | 3 | 4;

export interface Raster {
  readonly bitDepth: 1 | 8;
  readonly channels: RasterChannels;
  readonly data: Uint8Array;
  readonly height: number;
  readonly rowBytes: number;
  readonly width: number;
}

const chunk = (type: string, data: Uint8Array) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
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

export const encodePng = ({ bitDepth, channels, data, height, rowBytes, width }: Raster) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(bitDepth, 8);
  header.writeUInt8(COLOR_TYPES[channels], 9);
  const lineBytes = Math.ceil((width * channels * bitDepth) / BITS_PER_BYTE);
  const filtered = Buffer.alloc((lineBytes + 1) * height);
  for (let row = 0; row < height; row += 1) {
    filtered.set(
      data.subarray(row * rowBytes, row * rowBytes + lineBytes),
      row * (lineBytes + 1) + 1,
    );
  }
  return new Uint8Array(
    Buffer.concat([
      SIGNATURE,
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(filtered, { level: COMPRESSION_LEVEL })),
      chunk("IEND", new Uint8Array(0)),
    ]),
  );
};
