import { summary } from "@actions/core";
import { whenDefined } from "./object.ts";
import { thrownMessage } from "./thrown-message.ts";
import { Context, Effect, Layer } from "effect";
import { ActionSummaryError, ActionSummaryErrorReason } from "./errors/action-summary-error.ts";

export interface SummaryTableCell {
  readonly data: string;
  readonly header?: boolean;
  readonly colspan?: number;
  readonly rowspan?: number;
}

export interface SummaryImageOptions {
  readonly width?: string;
  readonly height?: string;
}

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface ActionSummaryApi {
  readonly addRaw: (text: string, addEOL?: boolean) => ActionSummaryApi;
  readonly addEOL: () => ActionSummaryApi;
  readonly addHeading: (text: string, level?: HeadingLevel) => ActionSummaryApi;
  readonly addCodeBlock: (code: string, lang?: string) => ActionSummaryApi;
  readonly addList: (items: readonly string[], ordered?: boolean) => ActionSummaryApi;
  readonly addTable: (rows: readonly (readonly SummaryTableCell[])[]) => ActionSummaryApi;
  readonly addDetails: (label: string, content: string) => ActionSummaryApi;
  readonly addImage: (src: string, alt: string, options?: SummaryImageOptions) => ActionSummaryApi;
  readonly addLink: (text: string, href: string) => ActionSummaryApi;
  readonly addSeparator: () => ActionSummaryApi;
  readonly addBreak: () => ActionSummaryApi;
  readonly addQuote: (text: string, cite?: string) => ActionSummaryApi;
  readonly stringify: () => string;
  readonly isEmptyBuffer: () => boolean;
  readonly emptyBuffer: () => ActionSummaryApi;
  readonly write: (options?: {
    readonly overwrite?: boolean;
  }) => Effect.Effect<ActionSummaryApi, ActionSummaryError>;
  readonly clear: () => Effect.Effect<ActionSummaryApi, ActionSummaryError>;
}

const writeFailed = (cause: unknown) =>
  new ActionSummaryError({
    cause,
    description: thrownMessage(cause, "GITHUB_STEP_SUMMARY could not be written"),
    reason: ActionSummaryErrorReason.WriteFailed,
  });

export class ActionSummary extends Context.Service<ActionSummary, ActionSummaryApi>()(
  "@computis/effect-github/ActionSummary",
) {
  static readonly layer = Layer.sync(ActionSummary, () => {
    const self: ActionSummaryApi = {
      addBreak: () => {
        summary.addBreak();
        return self;
      },
      addCodeBlock: (code, lang) => {
        summary.addCodeBlock(code, lang);
        return self;
      },
      addDetails: (label, content) => {
        summary.addDetails(label, content);
        return self;
      },
      addEOL: () => {
        summary.addEOL();
        return self;
      },
      addHeading: (text, level) => {
        summary.addHeading(text, level);
        return self;
      },
      addImage: (src, alt, options) => {
        summary.addImage(src, alt, options);
        return self;
      },
      addLink: (text, href) => {
        summary.addLink(text, href);
        return self;
      },
      addList: (items, ordered) => {
        summary.addList([...items], ordered);
        return self;
      },
      addQuote: (text, cite) => {
        summary.addQuote(text, cite);
        return self;
      },
      addRaw: (text, addEOL) => {
        summary.addRaw(text, addEOL);
        return self;
      },
      addSeparator: () => {
        summary.addSeparator();
        return self;
      },
      addTable: (rows) => {
        summary.addTable(
          rows.map((row) =>
            row.map((cell) => ({
              data: cell.data,
              ...whenDefined(cell.header, (header) => ({ header })),
              ...whenDefined(cell.colspan, (colspan) => ({ colspan: String(colspan) })),
              ...whenDefined(cell.rowspan, (rowspan) => ({ rowspan: String(rowspan) })),
            })),
          ),
        );
        return self;
      },
      clear: Effect.fn("ActionSummary.clear")(function* clear() {
        yield* Effect.tryPromise({ catch: writeFailed, try: async () => await summary.clear() });
        return self;
      }),
      emptyBuffer: () => {
        summary.emptyBuffer();
        return self;
      },
      isEmptyBuffer: () => summary.isEmptyBuffer(),
      stringify: () => summary.stringify(),
      write: Effect.fn("ActionSummary.write")(function* write(options?: {
        readonly overwrite?: boolean;
      }) {
        yield* Effect.tryPromise({
          catch: writeFailed,
          try: async () => await summary.write(options),
        });
        return self;
      }),
    };
    return self;
  });
}

const jobSummary = Effect.service(ActionSummary);

export const write = (options?: { readonly overwrite?: boolean }) =>
  jobSummary.pipe(Effect.flatMap((service) => service.write(options)));

export const clear = jobSummary.pipe(Effect.flatMap((service) => service.clear()));

export const { layer } = ActionSummary;
