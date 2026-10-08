import type { Pdfium } from "#effect-pdf/pdfium";

export const BYTES_PER_UTF16_UNIT = 2;
const BYTES_PER_FLOAT = 4;
export const BYTES_PER_DOUBLE = 8;

export const bitmapFormats = { bgr: 2, bgra: 4, gray: 1 } as const;

export const withAllocation = <A>(lib: Pdfium, size: number, action: (pointer: number) => A): A => {
  const pointer = lib.pdfium._malloc(Math.max(size, 1));
  try {
    return action(pointer);
  } finally {
    lib.pdfium._free(pointer);
  }
};

export const withUtf16 = <A>(lib: Pdfium, value: string, action: (pointer: number) => A): A => {
  const size = (value.length + 1) * BYTES_PER_UTF16_UNIT;
  return withAllocation(lib, size, (pointer) => {
    lib.pdfium.stringToUTF16(value, pointer, size);
    return action(pointer);
  });
};

export const readUtf16 = (
  lib: Pdfium,
  read: (buffer: number, size: number) => number,
): string | null => {
  const size = read(0, 0);
  if (size === 0) {
    return null;
  }
  return size <= BYTES_PER_UTF16_UNIT
    ? ""
    : withAllocation(lib, size, (buffer) => {
        read(buffer, size);
        return lib.pdfium.UTF16ToString(buffer);
      });
};

const FLOAT_DIGITS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

export const readFloats = (
  lib: Pdfium,
  count: number,
  fill: (pointer: number) => boolean,
): readonly number[] | null =>
  withAllocation(lib, count * BYTES_PER_FLOAT, (pointer): readonly number[] | null => {
    const start = pointer / BYTES_PER_FLOAT;
    return fill(pointer)
      ? Array.from(
          lib.pdfium.HEAPF32.subarray(start, start + count),
          (single) =>
            FLOAT_DIGITS.map((digits) => Number(single.toPrecision(digits))).find(
              (candidate) => Math.fround(candidate) === single,
            ) ?? single,
        )
      : null;
  });

export const readDoubles = (
  lib: Pdfium,
  count: number,
  fill: (pointer: number) => boolean,
): readonly number[] | null =>
  withAllocation(lib, count * BYTES_PER_DOUBLE, (pointer): readonly number[] | null => {
    const start = pointer / BYTES_PER_DOUBLE;
    return fill(pointer) ? [...lib.pdfium.HEAPF64.subarray(start, start + count)] : null;
  });
