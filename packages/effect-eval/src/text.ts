const CODE_POINT = /./gsu;
const BACKTICK = "`";
const MIN_FENCE = 3;
const BACKTICK_RUN = /`+/gu;
const LINE_BREAK = "\n";

export const codePoints = (text: string): readonly string[] => text.match(CODE_POINT) ?? [];

export const fenced = (text: string, info = "") => {
  const fence = BACKTICK.repeat(
    Math.max(MIN_FENCE, ...Array.from(text.matchAll(BACKTICK_RUN), ([run]) => run.length + 1)),
  );
  return [`${fence}${info}`, text, fence].join(LINE_BREAK);
};
