const digitClass = (low: string, high: string) => (low === high ? low : `[${low}-${high}]`);

const fixedWidthRange = (low: string, high: string): string => {
  if (low.length === 0) {
    return "";
  }
  const lowHead = low.charAt(0);
  const highHead = high.charAt(0);
  const lowTail = low.slice(1);
  const highTail = high.slice(1);
  if (lowHead === highHead) {
    const inner = fixedWidthRange(lowTail, highTail);
    return inner.includes("|") ? `${lowHead}(?:${inner})` : `${lowHead}${inner}`;
  }
  const anyDigits =
    lowTail.length <= 1 ? "[0-9]".repeat(lowTail.length) : `[0-9]{${String(lowTail.length)}}`;
  if (/^0*$/u.test(lowTail) && /^9*$/u.test(highTail)) {
    return `${digitClass(lowHead, highHead)}${anyDigits}`;
  }
  const lowNext = Number(lowHead) + 1;
  const highPrevious = Number(highHead) - 1;
  return [
    `${lowHead}(?:${fixedWidthRange(lowTail, "9".repeat(lowTail.length))})`,
    ...(lowNext <= highPrevious
      ? [`${digitClass(String(lowNext), String(highPrevious))}${anyDigits}`]
      : []),
    `${highHead}(?:${fixedWidthRange("0".repeat(lowTail.length), highTail)})`,
  ].join("|");
};

export const naturalRange = (low: bigint, high: bigint): string => {
  const lowText = low.toString();
  const highText = high.toString();
  if (lowText.length === highText.length) {
    return fixedWidthRange(lowText, highText);
  }
  const boundary = 10n ** BigInt(lowText.length);
  return `${fixedWidthRange(lowText, (boundary - 1n).toString())}|${naturalRange(boundary, high)}`;
};
