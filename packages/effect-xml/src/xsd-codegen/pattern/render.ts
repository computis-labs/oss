import { Match } from "effect";
import * as CharSet from "../charset.ts";
import type { RegexNode } from "./parse.ts";

export type WhiteSpace = "collapse" | "preserve" | "replace";

const WHITESPACE_CONTROLS = CharSet.make(
  [CharSet.TAB, CharSet.LINE_FEED],
  [CharSet.CARRIAGE_RETURN, CharSet.CARRIAGE_RETURN],
);

const WHITESPACE_CLASS = String.raw`[\t\n\r ]`;
const INNER_WHITESPACE = String.raw`(?<=[^\t\n\r ])[\t\n\r ]+(?=[^\t\n\r ])`;

const hex = (codePoint: number, width: number) =>
  codePoint.toString(16).toUpperCase().padStart(width, "0");

const NAMED_CONTROLS: ReadonlyMap<number, string> = new Map([
  [CharSet.TAB, String.raw`\t`],
  [CharSet.LINE_FEED, String.raw`\n`],
  [CharSet.CARRIAGE_RETURN, String.raw`\r`],
]);

const escapeCodePoint = (codePoint: number, special: string) => {
  const named = NAMED_CONTROLS.get(codePoint);
  if (named !== undefined) {
    return named;
  }
  if (codePoint >= 0x20 && codePoint <= 0x7e) {
    const char = String.fromCodePoint(codePoint);
    return special.includes(char) ? `\\${char}` : char;
  }
  return codePoint <= 0xff_ff ? `\\u${hex(codePoint, 4)}` : `\\u{${hex(codePoint, 1)}}`;
};

const renderSet = (value: CharSet.CharSet) => {
  const [first] = value;
  if (value.length === 1 && first !== undefined && first[0] === first[1]) {
    return escapeCodePoint(first[0], "^$\\.*+?()[]{}|/");
  }
  const tokens = value.flatMap(([start, end]) => {
    if (start === end) {
      return [[start]];
    }
    return end === start + 1 ? [[start], [end]] : [[start, end]];
  });
  const last = tokens.length - 1;
  const body = tokens.map(([start = 0, end], index) => {
    const edgeSingle = end === undefined && (index === 0 || index === last);
    const startSpecial = `\\]${index === 0 ? "^" : ""}${edgeSingle ? "" : "-"}`;
    return end === undefined
      ? escapeCodePoint(start, startSpecial)
      : `${escapeCodePoint(start, startSpecial)}-${escapeCodePoint(end, "\\]-")}`;
  });
  return `[${body.join("")}]`;
};

type Rendering = WhiteSpace | "canonical";

interface Rendered {
  readonly atomic: boolean;
  readonly choice: boolean;
  readonly source: string;
}

const groupChoice = (rendered: Rendered) =>
  rendered.choice ? `(?:${rendered.source})` : rendered.source;

const renderNode = (node: RegexNode, rendering: Rendering): Rendered => {
  if (node.kind === "sequence") {
    return {
      atomic: false,
      choice: false,
      source: node.items.map((item) => groupChoice(renderNode(item, rendering))).join(""),
    };
  }
  if (node.kind === "choice") {
    return {
      atomic: false,
      choice: true,
      source: node.branches.map((branch) => renderNode(branch, rendering).source).join("|"),
    };
  }
  if (node.kind === "repeat") {
    const inner = renderNode(node.node, rendering);
    const quantifier = Match.value({ max: node.max, min: node.min }).pipe(
      Match.when(
        ({ max, min }) => min === max,
        ({ min }) => (min === 1 ? "" : `{${String(min)}}`),
      ),
      Match.when(
        ({ max, min }) => min === 0 && max === 1,
        () => "?",
      ),
      Match.when(
        ({ max, min }) => max === undefined && min <= 1,
        ({ min }) => (min === 0 ? "*" : "+"),
      ),
      Match.orElse(({ max, min }) => `{${String(min)},${max === undefined ? "" : String(max)}}`),
    );
    return {
      atomic: false,
      choice: false,
      source: `${inner.atomic ? inner.source : `(?:${inner.source})`}${quantifier}`,
    };
  }
  const hasSpace = CharSet.has(node.set, CharSet.SPACE);
  const withoutControls = CharSet.subtract(node.set, WHITESPACE_CONTROLS);
  if (rendering === "preserve") {
    return { atomic: true, choice: false, source: renderSet(node.set) };
  }
  if (rendering === "replace") {
    const replaced = hasSpace
      ? CharSet.union(withoutControls, WHITESPACE_CONTROLS)
      : withoutControls;
    return { atomic: true, choice: false, source: renderSet(replaced) };
  }
  if (rendering === "canonical") {
    return { atomic: true, choice: false, source: renderSet(withoutControls) };
  }
  const visible = CharSet.subtract(node.set, CharSet.WHITESPACE);
  if (!hasSpace) {
    return { atomic: true, choice: false, source: renderSet(visible) };
  }
  return CharSet.isEmpty(visible)
    ? { atomic: false, choice: false, source: INNER_WHITESPACE }
    : { atomic: false, choice: true, source: `${renderSet(visible)}|${INNER_WHITESPACE}` };
};

export const render = (node: RegexNode, rendering: Rendering) => {
  const body = groupChoice(renderNode(node, rendering));
  return rendering === "collapse"
    ? `^${WHITESPACE_CLASS}*${body}${WHITESPACE_CLASS}*$`
    : `^${body}$`;
};
