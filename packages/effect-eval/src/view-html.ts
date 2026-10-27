import { Effect, Option, Ref, pipe } from "effect";
import { lookup } from "./object.ts";
import { computis, tones } from "./theme.ts";
import type { Theme, Tone } from "./theme.ts";
import { $match, drawingKinds, drawWith, unsupported } from "./view.ts";
import type { Block, ChartRenderer, TableData, View } from "./view.ts";

export interface HtmlOptions<E, R> {
  readonly title: string;
  readonly renderer?: ChartRenderer<E, R>;
  readonly theme?: Theme;
  readonly width?: number;
}

const DEFAULT_WIDTH = 960;
const LINE_BREAK = "\n";
const MAX_HEADING = 6;

const SPECIAL = /[&<>"']/gu;

export const escapeHtml = (text: string) =>
  text.replaceAll(
    SPECIAL,
    (character) =>
      lookup({ '"': "&quot;", "&": "&amp;", "'": "&#39;", "<": "&lt;", ">": "&gt;" }, character) ??
      character,
  );

const toneClass = (tone: Tone) => (tone === tones.neutral ? "" : ` class="tone-${tone}"`);

const table = (data: TableData) =>
  `<table><thead><tr>${data.columns
    .map((column) => `<th>${escapeHtml(column)}</th>`)
    .join("")}</tr></thead><tbody>${data.rows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td${toneClass(cell.tone)}>${escapeHtml(cell.text)}</td>`).join("")}</tr>`,
    )
    .join("")}</tbody></table>`;

export const render = <E = never, R = never>(view: View, options: HtmlOptions<E, R>) =>
  Effect.suspend(() => {
    const theme: Theme = options.theme ?? computis;
    const renderer = options.renderer ?? unsupported;
    const width = options.width ?? DEFAULT_WIDTH;
    const groups = Ref.makeUnsafe(0);
    const widest = Ref.makeUnsafe(0);

    const renderBlock = (block: Block, depth: number): Effect.Effect<string, E, R> =>
      $match(block, {
        Badge: ({ label, tone }) =>
          Effect.succeed(`<span class="badge tone-${tone}">${escapeHtml(label)}</span>`),
        Figure: ({ chart, fallback }) =>
          drawWith(renderer)([chart], {
            accepts: [drawingKinds.html, drawingKinds.text],
            theme,
            width,
          }).pipe(
            Effect.map(
              Option.match({
                onNone: () => table(fallback),
                onSome: (drawn) =>
                  drawn.kind === drawingKinds.html
                    ? drawn.content
                    : `<pre class="chart">${escapeHtml(drawn.content)}</pre>`,
              }),
            ),
          ),
        Row: ({ children }) =>
          pipe(
            children,
            Effect.forEach((child) => renderBlock(child, depth)),
            Effect.map((parts) => `<div class="row">${parts.join(LINE_BREAK)}</div>`),
          ),
        Section: ({ children, title }) =>
          pipe(
            children,
            Effect.forEach((child) => renderBlock(child, depth + 1)),
            Effect.map((parts) => {
              const level = String(Math.min(MAX_HEADING, depth));

              return `<section><h${level}>${escapeHtml(title)}</h${level}>${parts.join(LINE_BREAK)}</section>`;
            }),
          ),
        Table: (data) => Effect.succeed(table(data)),
        Tabs: ({ tabs }) =>
          pipe(
            tabs,
            Effect.forEach((tab) =>
              pipe(
                tab.children,
                Effect.forEach((child) => renderBlock(child, depth + 1)),
                Effect.map((parts) => parts.join(LINE_BREAK)),
              ),
            ),
            Effect.flatMap((panels) =>
              Ref.update(widest, (most) => Math.max(most, tabs.length)).pipe(
                Effect.andThen(Ref.getAndUpdate(groups, (count) => count + 1)),
                Effect.map((group) => {
                  const name = `tabs-${String(group)}`;

                  return `<div class="tabs">${tabs
                    .map(
                      (tab, index) =>
                        `<input type="radio" name="${name}" id="${name}-${String(index)}"${index === 0 ? " checked" : ""}><label for="${name}-${String(index)}">${escapeHtml(tab.title)}</label>`,
                    )
                    .join(
                      "",
                    )}${panels.map((panel) => `<div class="panel">${panel}</div>`).join("")}</div>`;
                }),
              ),
            ),
          ),
        Text: ({ text, tone }) => Effect.succeed(`<p${toneClass(tone)}>${escapeHtml(text)}</p>`),
      });

    const sheet = (tabCount: number) => `
:root { color-scheme: light; }
body { margin: 0; padding: 32px; background: ${theme.surface}; color: ${theme.text}; font: 14px/20px ${theme.font}; }
h1, h2, h3, h4 { font-weight: 700; margin: 24px 0 8px; }
table { border-collapse: collapse; margin: 8px 0; }
th { color: ${theme.muted}; font-weight: 500; text-align: left; }
th, td { border-bottom: 1px solid ${theme.border}; padding: 6px 12px 6px 0; vertical-align: top; }
.row { display: flex; flex-wrap: wrap; gap: 24px; align-items: flex-start; }
.badge { border-radius: 999px; padding: 2px 10px; font-weight: 700; border: 1px solid currentColor; }
pre.chart { font: 12px/16px ui-monospace, monospace; overflow-x: auto; }
${Object.entries(theme.tones)
  .map(([tone, color]) => `.tone-${tone} { color: ${color}; }`)
  .join(LINE_BREAK)}
.tabs > input { display: none; }
.tabs > label { display: inline-block; padding: 8px 16px; cursor: pointer; color: ${theme.muted}; border-bottom: 2px solid transparent; }
.tabs > input:checked + label { color: ${theme.text}; border-color: ${theme.text}; }
.tabs > .panel { display: none; border-top: 1px solid ${theme.border}; padding-top: 8px; }
${
  tabCount === 0
    ? ""
    : `${Array.from({ length: tabCount }, (_, index) => `.tabs > input:nth-of-type(${String(index + 1)}):checked ~ .panel:nth-of-type(${String(index + 1)})`).join(`,${LINE_BREAK}`)} { display: block; }`
}
`;

    return pipe(
      view,
      Effect.forEach((block) => renderBlock(block, 2)),
      Effect.flatMap((parts) =>
        Ref.get(widest).pipe(Effect.map((tabCount) => [parts, tabCount] as const)),
      ),
      Effect.map(
        ([parts, tabCount]) =>
          `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapeHtml(options.title)}</title>\n<style>${sheet(tabCount)}</style>\n</head>\n<body>\n<h1>${escapeHtml(options.title)}</h1>\n${parts.join(LINE_BREAK)}\n</body>\n</html>\n`,
      ),
    );
  });
