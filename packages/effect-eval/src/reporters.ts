import {
  Config,
  Console,
  Context,
  Effect,
  FileSystem,
  Option,
  Path,
  Stdio,
  Stream,
  Terminal,
  pipe,
} from "effect";
import type { PlatformError } from "effect";
import type { EvalHistoryError } from "./errors/eval-history-error.ts";
import * as Events from "./events.ts";
import * as History from "./history.ts";
import { whenDefined } from "./object.ts";
import * as Reporter from "./reporter.ts";
import type { Run } from "./run.ts";
import type { Theme } from "./theme.ts";
import * as View from "./view.ts";
import type { ChartRenderer, HistorySnapshot } from "./view.ts";
import * as ViewHtml from "./view-html.ts";
import * as ViewMarkdown from "./view-markdown.ts";
import * as ViewText from "./view-text.ts";

const DEFAULT_WIDTH = 100;
const LINE_BREAK = "\n";
const NO_COLOR = Config.option(Config.String("NO_COLOR"));
const CI = Config.option(Config.String("CI"));

export type Write = (text: string) => Effect.Effect<void>;

export const TerminalBuffer = Context.Reference<Option.Option<Write>>(
  "effect-eval/TerminalBuffer",
  {
    defaultValue: () => Option.none(),
  },
);

const destinationOf = (options: {
  readonly file?: string;
  readonly write?: Write;
}): Pick<Reporter.Options, "destination"> => {
  if (options.file !== undefined) {
    return { destination: Reporter.destinations.file };
  }

  return options.write === undefined ? { destination: Reporter.destinations.stdout } : {};
};

export const stdout: Write = (text) =>
  Console.log(text.endsWith(LINE_BREAK) ? text.slice(0, -1) : text);

export interface DrawOptions<E, R> {
  readonly view?: (run: Run, history: HistorySnapshot) => View.View;
  readonly renderer?: ChartRenderer<E, R>;
  readonly theme?: Theme;
}

export const terminalWidth = Effect.serviceOption(Terminal.Terminal).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () => Effect.succeed(DEFAULT_WIDTH),
      onSome: (terminal) => terminal.columns,
    }),
  ),
  Effect.map((columns) => (columns > 0 ? columns : DEFAULT_WIDTH)),
);

export const colorSupported = Effect.gen(function* detectColor() {
  const noColor = yield* Effect.orElseSucceed(NO_COLOR, () => Option.none<string>());

  if (Option.isSome(noColor)) {
    return false;
  }

  const stdio = yield* Effect.serviceOption(Stdio.Stdio);

  return Option.isSome(stdio) ? yield* stdio.value.stdoutIsTerminal : false;
});

export const isCi = Effect.orElseSucceed(CI, () => Option.none<string>()).pipe(
  Effect.map(Option.isSome),
);

const snapshotOf = (run: Run) =>
  History.snapshot(run).pipe(Effect.orElseSucceed(() => View.emptyHistory));

export const terminal = <E = never, R = never>(
  options: DrawOptions<E, R> & {
    readonly write?: Write;
    readonly color?: boolean;
    readonly width?: number;
    readonly progress?: boolean;
  } = {},
): Reporter.Reporter<E, R> => {
  const write = (text: string) =>
    TerminalBuffer.pipe(
      Effect.flatMap((buffer) => Option.getOrElse(buffer, () => options.write ?? stdout)(text)),
    );

  const progress = (line: () => string) =>
    TerminalBuffer.pipe(
      Effect.flatMap((buffer) =>
        options.progress === false || Option.isSome(buffer) ? Effect.void : write(line()),
      ),
    );

  return Reporter.make<E, R>({
    acceptsSensitive: true,
    delivery: Reporter.deliveries.sliding,
    ...destinationOf(options),
    name: "terminal",
    onComparison: (base, head) =>
      Effect.gen(function* drawComparison() {
        const width = options.width ?? (yield* terminalWidth);
        const color = options.color ?? (yield* colorSupported);

        const text = yield* ViewText.render(View.compare(base, head), {
          color,
          width,
          ...whenDefined(options.renderer, (renderer) => ({ renderer })),
          ...whenDefined(options.theme, (theme) => ({ theme })),
        });

        yield* write(text);
      }),
    onRunFinished: (run) =>
      Effect.gen(function* drawTerminal() {
        const history = yield* snapshotOf(run);
        const width = options.width ?? (yield* terminalWidth);
        const color = options.color ?? (yield* colorSupported);

        const text = yield* ViewText.render((options.view ?? View.summary)(run, history), {
          color,
          width,
          ...whenDefined(options.renderer, (renderer) => ({ renderer })),
          ...whenDefined(options.theme, (theme) => ({ theme })),
        });

        yield* write(text);
      }),
    onRunStarted: (started) =>
      progress(
        () =>
          `${started.eval}: ${String(started.plan.cases)} cases, ${String(
            started.plan.skipped,
          )} skipped, ${String(started.plan.invocations)} task calls`,
      ),
    onVariantFinished: (finished) =>
      progress(() => `${finished.variant}: done in ${(finished.durationMs / 1000).toFixed(1)} s`),
  });
};

const writeFile = (path: string, text: string) =>
  Effect.gen(function* writeReport() {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    yield* fs.makeDirectory(paths.dirname(path), { recursive: true });
    yield* fs.writeFileString(path, text);
  });

const COMPARE_SUFFIX = ".compare";

export const compareFileOf = (file: string) =>
  Path.Path.pipe(
    Effect.map((paths) => {
      const parsed = paths.parse(file);

      return paths.join(parsed.dir, `${parsed.name}${COMPARE_SUFFIX}${parsed.ext}`);
    }),
  );

const writeComparison =
  (options: { readonly file: string; readonly compareFile?: string }) => (text: string) =>
    (options.compareFile === undefined
      ? compareFileOf(options.file)
      : Effect.succeed(options.compareFile)
    ).pipe(Effect.flatMap((path) => writeFile(path, text)));

export const html = <E = never, R = never>(
  options: DrawOptions<E, R> & {
    readonly file: string;
    readonly compareFile?: string;
    readonly title?: string;
  },
): Reporter.Reporter<E | PlatformError.PlatformError, R | FileSystem.FileSystem | Path.Path> => {
  const drawing = {
    ...whenDefined(options.renderer, (renderer) => ({ renderer })),
    ...whenDefined(options.theme, (theme) => ({ theme })),
  };

  return Reporter.make({
    acceptsSensitive: true,
    destination: Reporter.destinations.file,
    name: "html",
    onComparison: (base, head) =>
      ViewHtml.render(View.compare(base, head), {
        title: options.title ?? `${head.eval} · ${base.id} → ${head.id}`,
        ...drawing,
      }).pipe(Effect.flatMap(writeComparison(options))),
    onRunFinished: (run) =>
      snapshotOf(run).pipe(
        Effect.flatMap((history) =>
          ViewHtml.render((options.view ?? View.dashboard)(run, history), {
            title: options.title ?? `${run.eval} · ${run.id}`,
            ...drawing,
          }),
        ),
        Effect.flatMap((text) => writeFile(options.file, text)),
      ),
  });
};

export const markdown = <E = never, R = never>(
  options: DrawOptions<E, R> & {
    readonly file?: string;
    readonly compareFile?: string;
    readonly write?: Write;
  } = {},
): Reporter.Reporter<E | PlatformError.PlatformError, R | FileSystem.FileSystem | Path.Path> => {
  const { file } = options;

  const output = (text: string) =>
    file === undefined ? (options.write ?? stdout)(text) : writeFile(file, text);

  const comparisonOutput = (text: string) =>
    file === undefined
      ? (options.write ?? stdout)(text)
      : writeComparison({
          file,
          ...whenDefined(options.compareFile, (compareFile) => ({ compareFile })),
        })(text);

  const drawing = {
    ...whenDefined(options.renderer, (renderer) => ({ renderer })),
    ...whenDefined(options.theme, (theme) => ({ theme })),
  };

  return Reporter.make({
    ...destinationOf(options),
    name: "markdown",
    onComparison: (base, head) =>
      ViewMarkdown.render(View.compare(base, head), drawing).pipe(Effect.flatMap(comparisonOutput)),
    onRunFinished: (run) =>
      snapshotOf(run).pipe(
        Effect.flatMap((history) =>
          ViewMarkdown.render((options.view ?? View.summary)(run, history), drawing),
        ),
        Effect.flatMap(output),
      ),
  });
};

export const json = (
  options: { readonly file?: string; readonly write?: Write } = {},
): Reporter.Reporter<PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Reporter.fromStream(
    "json",
    (events) => {
      const lines = events.pipe(
        Stream.mapEffect((event) => Effect.orDie(Events.encodeLine(event))),
      );

      const { file } = options;

      if (file === undefined) {
        const write = options.write ?? stdout;

        return Stream.runForEach(lines, write);
      }

      return pipe(
        Stream.runCollect(lines),
        Effect.flatMap((all) => writeFile(file, `${all.join(LINE_BREAK)}${LINE_BREAK}`)),
      );
    },
    destinationOf(options),
  );

export const history: Reporter.Reporter<EvalHistoryError, History.History> = History.reporter;

export { silent } from "./reporter.ts";
