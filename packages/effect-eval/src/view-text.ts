import { Effect, Option, pipe } from "effect";
import type { Chart } from "./chart.ts";
import { computis, tones } from "./theme.ts";
import type { Theme, Tone } from "./theme.ts";
import { codePoints } from "./text.ts";
import { $is, $match, drawingKinds, drawWith, Section, unsupported } from "./view.ts";
import type { Block, ChartRenderer, TableData, View } from "./view.ts";

export interface TextOptions<E, R> {
  readonly width: number;
  readonly color: boolean;
  readonly renderer?: ChartRenderer<E, R>;
  readonly theme?: Theme;
}

const ESCAPE = "\u001B[";
const RESET = `${ESCAPE}0m`;

// oxlint-disable-next-line no-control-regex -- ANSI escape sequences
const ANSI = /\u001B\[[0-9;]*m/gu;
const CHART_MIN_WIDTH = 60;
const GAP = "  ";
const MAX_CELL = 48;
const ELLIPSIS = "…";
const LINE_BREAK = "\n";

export const visibleLength = (text: string) => codePoints(text.replaceAll(ANSI, "")).length;

const pad = (text: string, width: number) =>
  `${text}${" ".repeat(Math.max(0, width - visibleLength(text)))}`;

const truncate = (text: string, width: number) => {
  const characters = codePoints(text);

  return characters.length <= width
    ? text
    : `${characters.slice(0, Math.max(0, width - 1)).join("")}${ELLIPSIS}`;
};

const columnWidths = (data: TableData) =>
  data.columns.map((column, index) =>
    Math.min(
      MAX_CELL,
      Math.max(
        visibleLength(column),
        ...data.rows.map((row) => visibleLength(row[index]?.text ?? "")),
      ),
    ),
  );

const minimumWidth = (block: Block): number =>
  $match(block, {
    Badge: ({ label }) => visibleLength(label) + 4,
    Figure: () => CHART_MIN_WIDTH,
    Row: ({ children }) =>
      children.map(minimumWidth).reduce((total, width) => total + width + GAP.length, 0),
    Section: ({ children }) => Math.max(0, ...children.map(minimumWidth)),
    Table: (data) => columnWidths(data).reduce((total, width) => total + width + GAP.length, 0),
    Tabs: ({ tabs }) => Math.max(0, ...tabs.flatMap((tab) => tab.children.map(minimumWidth))),
    Text: ({ text }) => visibleLength(text),
  });

export const render = <E = never, R = never>(view: View, options: TextOptions<E, R>) => {
  const theme = options.theme ?? computis;
  const renderer = options.renderer ?? unsupported;

  const paint = (text: string, tone: Tone) =>
    options.color && tone !== tones.neutral
      ? `${ESCAPE}${{ bad: "31", good: "32", info: "34", neutral: "2", warn: "33" }[tone]}m${text}${RESET}`
      : text;

  const bold = (text: string) => (options.color ? `${ESCAPE}1m${text}${RESET}` : text);
  const dim = (text: string) => (options.color ? `${ESCAPE}2m${text}${RESET}` : text);

  const renderTable = (data: TableData) => {
    const widths = columnWidths(data);

    const line = (cells: readonly string[]) =>
      cells
        .map((text, index) => pad(text, widths[index] ?? 0))
        .join(GAP)
        .trimEnd();

    return [
      dim(line(data.columns.map((column, index) => truncate(column, widths[index] ?? 0)))),
      ...data.rows.map((row) =>
        line(
          row.map((entry, index) => paint(truncate(entry.text, widths[index] ?? 0), entry.tone)),
        ),
      ),
    ].join(LINE_BREAK);
  };

  const draw = (charts: readonly Chart[], width: number) =>
    drawWith(renderer)(charts, {
      accepts: [drawingKinds.text, drawingKinds.terminal],
      theme,
      width,
    }).pipe(Effect.map(Option.map((drawn) => drawn.content)));

  const renderCharts = (charts: readonly Chart[], fallback: readonly TableData[], width: number) =>
    draw(charts, width).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            pipe(
              charts,
              Effect.forEach((chart) =>
                charts.length === 1 ? Effect.succeed(Option.none<string>()) : draw([chart], width),
              ),
              Effect.map((drawn) =>
                drawn
                  .map((one, index) =>
                    Option.getOrElse(one, () => {
                      const table = fallback[index];

                      return table === undefined ? "" : renderTable(table);
                    }),
                  )
                  .join(`${LINE_BREAK}${LINE_BREAK}`),
              ),
            ),
          onSome: (drawn) => Effect.succeed(drawn),
        }),
      ),
    );

  const renderBlock = (block: Block, width: number): Effect.Effect<string, E, R> =>
    $match(block, {
      Badge: ({ label, tone }) => Effect.succeed(paint(`[ ${label.toUpperCase()} ]`, tone)),
      Figure: ({ chart, fallback }) => renderCharts([chart], [fallback], width),
      Row: ({ children }) => {
        const figures = children.filter($is("Figure"));

        if (figures.length > 0 && figures.length === children.length) {
          return renderCharts(
            figures.map((entry) => entry.chart),
            figures.map((entry) => entry.fallback),
            width,
          );
        }

        const minimums = children.map(minimumWidth);

        const fits =
          minimums.reduce((total, minimum) => total + minimum, 0) +
            GAP.length * Math.max(0, children.length - 1) <=
          width;

        if (!fits) {
          return pipe(
            children,
            Effect.forEach((child) => renderBlock(child, width)),
            Effect.map((parts) => parts.join(LINE_BREAK)),
          );
        }

        return pipe(
          children,
          Effect.forEach((child, index) => renderBlock(child, minimums[index] ?? width)),
          Effect.map((parts) => {
            const columns = parts.map((part) => part.split(LINE_BREAK));
            const widths = columns.map((lines) => Math.max(0, ...lines.map(visibleLength)));
            const height = Math.max(0, ...columns.map((lines) => lines.length));

            return Array.from({ length: height }, (_, line) =>
              columns
                .map((lines, index) => pad(lines[line] ?? "", widths[index] ?? 0))
                .join(GAP)
                .trimEnd(),
            ).join(LINE_BREAK);
          }),
        );
      },
      Section: ({ children, title }) =>
        pipe(
          children,
          Effect.forEach((child) => renderBlock(child, width)),
          Effect.map((parts) => [bold(title), ...parts].join(LINE_BREAK)),
        ),
      Table: (data) => Effect.succeed(renderTable(data)),
      Tabs: ({ tabs }) =>
        pipe(
          tabs,
          Effect.forEach((tab) =>
            renderBlock(Section({ children: tab.children, title: tab.title }), width),
          ),
          Effect.map((parts) => parts.join(`${LINE_BREAK}${LINE_BREAK}`)),
        ),
      Text: ({ text, tone }) => Effect.succeed(paint(text, tone)),
    });

  return pipe(
    view,
    Effect.forEach((block) => renderBlock(block, options.width)),
    Effect.map((parts) => `${parts.join(`${LINE_BREAK}${LINE_BREAK}`)}${LINE_BREAK}`),
  );
};
