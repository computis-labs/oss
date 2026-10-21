import { Effect, Option, pipe } from "effect";
import { fenced } from "./text.ts";
import { computis, tones } from "./theme.ts";
import type { Theme, Tone } from "./theme.ts";
import { $is, $match, drawingKinds, drawWith, unsupported } from "./view.ts";
import type { Block, ChartRenderer, TableData, View } from "./view.ts";

export interface MarkdownOptions<E, R> {
  readonly renderer?: ChartRenderer<E, R>;
  readonly theme?: Theme;
  readonly width?: number;
}

const DEFAULT_WIDTH = 80;
const LINE_BREAK = "\n";
const PARAGRAPH = "\n\n";
const PIPE = /\|/gu;
const NEWLINES = /\r?\n/gu;

const escapeCell = (text: string) => text.replaceAll(PIPE, "\\|").replaceAll(NEWLINES, " ");

const withTone = (text: string, tone: Tone) =>
  tone === tones.neutral
    ? text
    : `${{ bad: "❌", good: "✅", info: "ℹ️", warn: "⚠️" }[tone]} ${text}`;

export const table = (data: TableData) =>
  [
    `| ${data.columns.map(escapeCell).join(" | ")} |`,
    `| ${data.columns.map(() => "---").join(" | ")} |`,
    ...data.rows.map(
      (row) => `| ${row.map((cell) => escapeCell(withTone(cell.text, cell.tone))).join(" | ")} |`,
    ),
  ].join(LINE_BREAK);

export const render = <E = never, R = never>(view: View, options: MarkdownOptions<E, R> = {}) => {
  const theme = options.theme ?? computis;
  const renderer = options.renderer ?? unsupported;
  const width = options.width ?? DEFAULT_WIDTH;
  const renderBlock = (block: Block, depth: number): Effect.Effect<string, E, R> =>
    $match(block, {
      Badge: ({ label, tone }) => Effect.succeed(`**${withTone(label.toUpperCase(), tone)}**`),
      Figure: ({ chart, fallback }) =>
        drawWith(renderer)([chart], {
          accepts: [drawingKinds.markdown, drawingKinds.text],
          theme,
          width,
        }).pipe(
          Effect.map(
            Option.match({
              onNone: () => table(fallback),
              onSome: (drawn) =>
                drawn.kind === drawingKinds.markdown ? drawn.content : fenced(drawn.content),
            }),
          ),
        ),
      Row: ({ children }) => {
        const separator =
          children.every($is("Figure")) || children.some($is("Table")) ? PARAGRAPH : " ";
        return pipe(
          children,
          Effect.forEach((child) => renderBlock(child, depth)),
          Effect.map((parts) => parts.join(separator)),
        );
      },
      Section: ({ children, title }) =>
        pipe(
          children,
          Effect.forEach((child) => renderBlock(child, depth + 1)),
          Effect.map((parts) =>
            [`${"#".repeat(Math.min(6, depth))} ${title}`, ...parts].join(PARAGRAPH),
          ),
        ),
      Table: (data) => Effect.succeed(table(data)),
      Tabs: ({ tabs }) =>
        pipe(
          tabs,
          Effect.forEach((tab) =>
            pipe(
              tab.children,
              Effect.forEach((child) => renderBlock(child, depth + 1)),
              Effect.map((parts) =>
                [`${"#".repeat(Math.min(6, depth))} ${tab.title}`, ...parts].join(PARAGRAPH),
              ),
            ),
          ),
          Effect.map((parts) => parts.join(PARAGRAPH)),
        ),
      Text: ({ text, tone }) => Effect.succeed(withTone(text, tone)),
    });
  return pipe(
    view,
    Effect.forEach((block) => renderBlock(block, 2)),
    Effect.map((parts) => `${parts.join(PARAGRAPH)}${LINE_BREAK}`),
  );
};
