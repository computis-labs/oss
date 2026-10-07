export type Range = readonly [number, number];

export type CharSet = readonly Range[];

export const TAB = 0x09;
export const LINE_FEED = 0x0a;
export const CARRIAGE_RETURN = 0x0d;
export const SPACE = 0x20;

const normalize = (ranges: readonly Range[]): CharSet => {
  const sorted = ranges.toSorted(([left], [right]) => left - right);
  const merged: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
};

export const make = (...ranges: readonly Range[]): CharSet => normalize(ranges);

export const single = (codePoint: number): CharSet => [[codePoint, codePoint]];

export const union = (...sets: readonly CharSet[]): CharSet => normalize(sets.flat());

export const XML_CHAR: CharSet = make(
  [TAB, LINE_FEED],
  [CARRIAGE_RETURN, CARRIAGE_RETURN],
  [SPACE, 0xd7_ff],
  [0xe0_00, 0xff_fd],
  [0x1_00_00, 0x10_ff_ff],
);

export const WHITESPACE: CharSet = make(
  [TAB, LINE_FEED],
  [CARRIAGE_RETURN, CARRIAGE_RETURN],
  [SPACE, SPACE],
);

export const LINE_BREAKS: CharSet = make(
  [LINE_FEED, LINE_FEED],
  [CARRIAGE_RETURN, CARRIAGE_RETURN],
);

export const intersect = (left: CharSet, right: CharSet): CharSet =>
  left.flatMap(([leftStart, leftEnd]) =>
    right.flatMap(([rightStart, rightEnd]): Range[] => {
      const start = Math.max(leftStart, rightStart);
      const end = Math.min(leftEnd, rightEnd);
      return start <= end ? [[start, end]] : [];
    }),
  );

export const subtract = (set: CharSet, removed: CharSet): CharSet =>
  set.flatMap(([start, end]) => {
    const overlapping = removed.filter(
      ([removedStart, removedEnd]) => removedEnd >= start && removedStart <= end,
    );
    const gapStarts = [start, ...overlapping.map(([, removedEnd]) => removedEnd + 1)];
    const gapEnds = [...overlapping.map(([removedStart]) => removedStart - 1), end];
    return gapStarts.flatMap((gapStart, index): Range[] => {
      const gapEnd = gapEnds[index] ?? end;
      return gapStart <= gapEnd ? [[gapStart, gapEnd]] : [];
    });
  });

export const complement = (set: CharSet): CharSet => subtract(XML_CHAR, set);

export const has = (set: CharSet, codePoint: number) =>
  set.some(([start, end]) => codePoint >= start && codePoint <= end);

export const isEmpty = (set: CharSet) => set.length === 0;

export const isBmp = (set: CharSet) => set.every(([, end]) => end <= 0xff_ff);
