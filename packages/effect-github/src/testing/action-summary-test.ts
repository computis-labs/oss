import { Effect, Layer } from "effect";
import { ActionSummary } from "../action-summary.ts";
import type { ActionSummaryApi } from "../action-summary.ts";
import { ActionSummaryError, ActionSummaryErrorReason } from "../errors/action-summary-error.ts";

const attribute = (name: string, value: string | number | undefined) =>
  value === undefined ? "" : ` ${name}="${value}"`;

export const make = (
  options: { readonly writeError?: string; readonly clearError?: string } = {},
) => {
  const chunks = Array.of<string>();

  const summary: ActionSummaryApi = {
    addBreak: () => summary.addRaw("<br>\n"),
    addCodeBlock: (code, lang) =>
      summary.addRaw(`<pre${attribute("lang", lang)}><code>${code}</code></pre>\n`),
    addDetails: (label, content) =>
      summary.addRaw(`<details><summary>${label}</summary>${content}</details>\n`),
    addEOL: () => summary.addRaw("\n"),
    addHeading: (text, level = 1) => summary.addRaw(`<h${level}>${text}</h${level}>\n`),
    addImage: (src, alt, imageOptions) =>
      summary.addRaw(
        `<img src="${src}" alt="${alt}"${attribute("width", imageOptions?.width)}${attribute("height", imageOptions?.height)}>\n`,
      ),
    addLink: (text, href) => summary.addRaw(`<a href="${href}">${text}</a>\n`),
    addList: (items, ordered = false) => {
      const tag = ordered ? "ol" : "ul";

      return summary.addRaw(
        `<${tag}>${items.map((item) => `<li>${item}</li>`).join("")}</${tag}>\n`,
      );
    },
    addQuote: (text, cite) =>
      summary.addRaw(`<blockquote${attribute("cite", cite)}>${text}</blockquote>\n`),
    addRaw: (text, addEOL = false) => {
      chunks.push(addEOL ? `${text}\n` : text);

      return summary;
    },
    addSeparator: () => summary.addRaw("<hr>\n"),
    addTable: (rows) => {
      const body = rows
        .map((row) => {
          const cells = row.map((cell) => {
            const tag = cell.header === true ? "th" : "td";

            return `<${tag}${attribute("colspan", cell.colspan)}${attribute("rowspan", cell.rowspan)}>${cell.data}</${tag}>`;
          });

          return `<tr>${cells.join("")}</tr>`;
        })
        .join("");

      return summary.addRaw(`<table>${body}</table>\n`);
    },
    clear: () =>
      options.clearError === undefined
        ? Effect.sync(() => {
            chunks.splice(0);

            return summary;
          })
        : Effect.fail(
            new ActionSummaryError({
              description: options.clearError,
              reason: ActionSummaryErrorReason.WriteFailed,
            }),
          ),
    emptyBuffer: () => {
      chunks.splice(0);

      return summary;
    },
    isEmptyBuffer: () => chunks.every((chunk) => chunk === ""),
    stringify: () => chunks.join(""),
    write: () =>
      options.writeError === undefined
        ? Effect.succeed(summary)
        : Effect.fail(
            new ActionSummaryError({
              description: options.writeError,
              reason: ActionSummaryErrorReason.WriteFailed,
            }),
          ),
  };

  return { getBuffer: () => chunks.join(""), layer: Layer.succeed(ActionSummary, summary) };
};

export const { layer } = make();
