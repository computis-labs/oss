import { Effect, FileSystem, Layer, Option, Path, Predicate, Result, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { EvalConfigError } from "./errors/eval-config-error.ts";
import * as History from "./history.ts";
import { whenDefined } from "./object.ts";
import * as Reporter from "./reporter.ts";
import * as Reporters from "./reporters.ts";
import type { Run } from "./run.ts";
import { ThemeSchema } from "./theme.ts";
import type { Theme } from "./theme.ts";
import type { ChartRenderer, HistorySnapshot, View } from "./view.ts";

export type Services =
  | FileSystem.FileSystem
  | Path.Path
  | History.History
  | ChildProcessSpawner.ChildProcessSpawner;

export type ConfiguredReporter = Reporter.Reporter<unknown, Services>;

export interface BuiltinOptions {
  readonly file?: string;
  readonly compareFile?: string;
  readonly title?: string;
}

export interface ProcessOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly name?: string;
}

export const PROCESS = "process";

export type ReporterEntry =
  | string
  | readonly [name: typeof PROCESS, options: ProcessOptions]
  | readonly [name: string, options: BuiltinOptions]
  | ConfiguredReporter;

export interface EvalConfig {
  readonly reporters?: readonly ReporterEntry[];
  readonly history?: {
    readonly enabled?: boolean;
    readonly directory?: string;
    readonly baseBranch?: string;
  };
  readonly view?: (run: Run, history: HistorySnapshot) => View;
  readonly renderer?: ChartRenderer;
  readonly theme?: Theme;
}

export const define = (config: EvalConfig): EvalConfig => config;

export const FILE_NAMES = [
  "eval.config.ts",
  "eval.config.mts",
  "eval.config.js",
  "eval.config.mjs",
];

export const DEFAULT_HTML = ".eval/report.html";

export const builtinNames = {
  history: "history",
  html: "html",
  json: "json",
  markdown: "markdown",
  silent: "silent",
  terminal: "terminal",
} as const;

const FunctionSchema = Schema.declare(Predicate.isFunction, { expected: "a function" });

const ReporterSchema = Schema.Struct({
  acceptsSensitive: Schema.Boolean,
  compare: Schema.optionalKey(FunctionSchema),
  consume: FunctionSchema,
  delivery: Schema.Literals([Reporter.deliveries.all, Reporter.deliveries.sliding]),
  destination: Schema.optionalKey(
    Schema.Literals([Reporter.destinations.file, Reporter.destinations.stdout]),
  ),
  name: Schema.String,
  required: Schema.Boolean,
});

const ReporterModuleSchema = Schema.Struct({ default: ReporterSchema });

const ProcessOptionsSchema = Schema.Struct({
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  command: Schema.String,
  name: Schema.optionalKey(Schema.String),
});

const isProcessEntry = (
  entry: readonly [string, BuiltinOptions | ProcessOptions],
): entry is readonly [typeof PROCESS, ProcessOptions] => entry[0] === PROCESS;

const ConfigModuleSchema = Schema.Struct({
  default: Schema.Struct({
    history: Schema.optionalKey(
      Schema.Struct({
        baseBranch: Schema.optionalKey(Schema.String),
        directory: Schema.optionalKey(Schema.String),
        enabled: Schema.optionalKey(Schema.Boolean),
      }),
    ),
    renderer: Schema.optionalKey(FunctionSchema),
    reporters: Schema.optionalKey(
      Schema.Array(
        Schema.Union([
          Schema.String,
          Schema.Tuple([
            Schema.String,
            Schema.Struct({
              args: Schema.optionalKey(Schema.Array(Schema.String)),
              command: Schema.optionalKey(Schema.String),
              compareFile: Schema.optionalKey(Schema.String),
              file: Schema.optionalKey(Schema.String),
              name: Schema.optionalKey(Schema.String),
              title: Schema.optionalKey(Schema.String),
            }),
          ]),
          ReporterSchema,
        ]),
      ),
    ),
    theme: Schema.optionalKey(ThemeSchema),
    view: Schema.optionalKey(FunctionSchema),
  }),
});

export const find = Effect.fn("EvalConfig.find")(function* findConfig(cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;

  const folders = (folder: string): readonly string[] => {
    const parent = paths.dirname(folder);

    return parent === folder ? [folder] : [folder, ...folders(parent)];
  };

  const candidates = folders(paths.resolve(cwd)).flatMap((folder) =>
    FILE_NAMES.map((name) => paths.join(folder, name)),
  );

  const found = yield* Effect.findFirst(candidates, (candidate) =>
    fs.exists(candidate).pipe(Effect.orElseSucceed(() => false)),
  );

  return found;
});

const importDefault = (file: string, schema: Schema.ConstraintDecoder<unknown>, message: string) =>
  Effect.gen(function* importFile() {
    const paths = yield* Path.Path;

    const url = yield* paths
      .toFileUrl(file)
      .pipe(
        Effect.mapError(
          (cause) => new EvalConfigError({ cause, message: "The path is not a file.", path: file }),
        ),
      );

    const keeping = Schema.Unknown.check(
      Schema.makeFilter((input) =>
        Result.match(Schema.decodeUnknownResult(schema)(input), {
          onFailure: (error) => error.issue,
          onSuccess: () => true,
        }),
      ),
    );

    const checked = yield* Effect.tryPromise({
      catch: (cause) =>
        new EvalConfigError({ cause, message: "The module cannot be imported.", path: file }),
      try: async () => Schema.decodeUnknownResult(keeping)(await import(url.href)),
    });

    return yield* Result.match(checked, {
      onFailure: (cause) => Effect.fail(new EvalConfigError({ cause, message, path: file })),
      onSuccess: (imported) =>
        Effect.succeed(Predicate.hasProperty(imported, "default") ? imported.default : undefined),
    });
  });

export const load = Effect.fn("EvalConfig.load")(function* loadConfig(cwd: string) {
  const file = yield* find(cwd);

  if (Option.isNone(file)) {
    return Option.none<EvalConfig>();
  }

  const exported = yield* importDefault(
    file.value,
    ConfigModuleSchema,
    "The default export is not an EvalConfig: export default EvalConfig.define({ … }).",
  );

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: the schema checked every key of the config without rebuilding it, so reporter values keep their hooks; the reporter, view and renderer functions are only known to be functions.
  const config = exported as EvalConfig;
  const paths = yield* Path.Path;
  const directory = paths.dirname(file.value);

  const anchored = (entry: ReporterEntry): ReporterEntry =>
    Predicate.isString(entry) && !Object.values(builtinNames).some((name) => name === entry)
      ? paths.resolve(directory, entry)
      : entry;

  return Option.some({
    ...config,
    ...whenDefined(config.reporters, (reporters) => ({ reporters: reporters.map(anchored) })),
  });
});

const takingOptions: readonly string[] = [
  builtinNames.html,
  builtinNames.markdown,
  builtinNames.json,
];

export const drawingOf = (config: EvalConfig) => ({
  ...whenDefined(config.renderer, (renderer) => ({ renderer })),
  ...whenDefined(config.theme, (theme) => ({ theme })),
  ...whenDefined(config.view, (view) => ({ view })),
});

export const builtin = (
  name: string,
  config: EvalConfig = {},
  options: BuiltinOptions = {},
): Option.Option<ConfiguredReporter> => {
  const drawing = drawingOf(config);
  const file = whenDefined(options.file, (path) => ({ file: path }));
  const compareFile = whenDefined(options.compareFile, (path) => ({ compareFile: path }));

  if (name === builtinNames.terminal) {
    return Option.some(Reporters.terminal(drawing));
  }

  if (name === builtinNames.html) {
    return Option.some(
      Reporters.html({
        ...drawing,
        file: options.file ?? DEFAULT_HTML,
        ...compareFile,
        ...whenDefined(options.title, (title) => ({ title })),
      }),
    );
  }

  if (name === builtinNames.markdown) {
    return Option.some(Reporters.markdown({ ...drawing, ...file, ...compareFile }));
  }

  if (name === builtinNames.json) {
    return Option.some(Reporters.json(file));
  }

  if (name === builtinNames.silent) {
    return Option.some(Reporter.silent);
  }

  if (name === builtinNames.history) {
    return Option.some(History.reporter);
  }

  return Option.none();
};

export const resolveReporter = Effect.fn("EvalConfig.resolveReporter")(function* resolveOne(
  entry: ReporterEntry,
  options: { readonly cwd: string; readonly config?: EvalConfig },
) {
  if (Predicate.isString(entry)) {
    const known = builtin(entry, options.config);

    if (Option.isSome(known)) {
      return known.value;
    }

    const paths = yield* Path.Path;
    const file = paths.resolve(options.cwd, entry);

    const exported = yield* importDefault(
      file,
      ReporterModuleSchema,
      `${entry} is not a built-in reporter (${Object.values(builtinNames).join(", ")}) and its module does not export a Reporter by default.`,
    );

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: the schema checked every field of the Reporter without rebuilding it, so its hooks stay; consume and compare are only known to be functions.
    const reporter = exported as ConfiguredReporter;

    return reporter;
  }

  if (Predicate.hasProperty(entry, "consume")) {
    return entry;
  }

  if (isProcessEntry(entry)) {
    return yield* Schema.decodeUnknownEffect(ProcessOptionsSchema)(entry[1]).pipe(
      Effect.mapError(
        (cause) =>
          new EvalConfigError({
            cause,
            message: 'A process reporter needs a command: ["process", { command, args?, name? }].',
            path: PROCESS,
          }),
      ),
      Effect.map((given) => Reporter.process(given.name ?? PROCESS, given.command, given.args)),
    );
  }

  const [name, given] = entry;

  return yield* Option.match(
    takingOptions.includes(name) ? builtin(name, options.config, given) : Option.none(),
    {
      onNone: () =>
        Effect.fail(
          new EvalConfigError({
            message: `Only the built-in reporters ${takingOptions.join(", ")} take options.`,
            path: name,
          }),
        ),
      onSome: (reporter) => Effect.succeed(reporter),
    },
  );
});

export const historyEnabled = (config: EvalConfig) => config.history?.enabled ?? true;

export const withoutHistory = <Item extends { readonly name: string }>(
  reporters: readonly Item[],
  enabled: boolean,
): readonly Item[] =>
  enabled ? reporters : reporters.filter((reporter) => reporter.name !== builtinNames.history);

export const historyLayer = (config: EvalConfig) =>
  Layer.merge(
    History.layerFileSystem(config.history?.directory ?? History.DEFAULT_ROOT),
    Layer.succeed(History.ConfiguredBaseBranch, Option.fromNullishOr(config.history?.baseBranch)),
  );

export const defaultReporters: readonly string[] = [builtinNames.terminal, builtinNames.history];
