import {
  Config,
  Context,
  Data,
  DateTime,
  Effect,
  Equal,
  FileSystem,
  Layer,
  Option,
  Order,
  Path,
  Ref,
  Schema,
  Semaphore,
  Stream,
  pipe,
} from "effect";
import { EvalHistoryError } from "./errors/eval-history-error.ts";
import * as Events from "./events.ts";
import type { EvalEvent } from "./events.ts";
import { RedactsSensitive, exposing, redactRun } from "./redact.ts";
import * as Reporter from "./reporter.ts";
import { fold } from "./run.ts";
import type { Run } from "./run.ts";
import { emptyHistory } from "./view.ts";
import type { HistorySnapshot } from "./view.ts";

export const IndexEntrySchema = Schema.Struct({
  branch: Schema.OptionFromNullOr(Schema.String),
  dirty: Schema.Boolean,
  eval: Schema.String,
  id: Schema.String,
  interrupted: Schema.Boolean,
  passed: Schema.Boolean,
  rescoreOf: Schema.OptionFromNullOr(Schema.String),
  sha: Schema.OptionFromNullOr(Schema.String),
  startedAt: Schema.DateTimeUtcFromString,
  trials: Schema.Finite,
  variants: Schema.Array(Schema.String),
});

export type IndexEntry = typeof IndexEntrySchema.Type;

export class History extends Context.Service<
  History,
  {
    readonly save: (events: readonly EvalEvent[]) => Effect.Effect<void, EvalHistoryError>;
    readonly index: (evalName: string) => Effect.Effect<readonly IndexEntry[], EvalHistoryError>;
    readonly events: (
      evalName: string,
      id: string,
    ) => Effect.Effect<readonly EvalEvent[], EvalHistoryError>;
    readonly file: (path: string) => Effect.Effect<readonly EvalEvent[], EvalHistoryError>;
  }
>()("effect-eval/History") {}

export const DEFAULT_ROOT = ".eval/history";
export const DEFAULT_BASE_BRANCH = "main";

export const ConfiguredBaseBranch = Context.Reference<Option.Option<string>>(
  "effect-eval/ConfiguredBaseBranch",
  { defaultValue: () => Option.none() },
);

export const baseBranch = Effect.gen(function* resolveBaseBranch() {
  const fromEnvironment = yield* Config.option(Config.String("EVAL_BASE_BRANCH")).pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
  );

  const configured = yield* ConfiguredBaseBranch;

  return pipe(
    fromEnvironment,
    Option.orElse(() => configured),
    Option.getOrElse(() => DEFAULT_BASE_BRANCH),
  );
});

const INDEX_FILE = "index.jsonl";
const DEFAULT_RECENT = 10;
const RUN_EXTENSION = ".jsonl";
const LINE_BREAK = "\n";

export type Selector = Data.TaggedEnum<{
  Id: { readonly id: string };
  Latest: object;
  Baseline: { readonly branch: Option.Option<string> };
  Branch: { readonly branch: string };
  File: { readonly path: string };
}>;

const { $is, $match, Baseline, Branch, File, Id, Latest } = Data.taggedEnum<Selector>();

export const id = (value: string): Selector => Id({ id: value });
export const latest: Selector = Latest();

export const baseline = (branch?: string): Selector =>
  Baseline({ branch: Option.fromNullishOr(branch) });

export const onBranch = (branch: string): Selector => Branch({ branch });
export const fromFile = (path: string): Selector => File({ path });

const LATEST = "latest";
const BASELINE = "baseline";

export const parseSelector = (text: string, branch?: string): Selector => {
  if (text === LATEST) {
    return latest;
  }

  if (text === BASELINE) {
    return baseline(branch);
  }

  if (text.endsWith(RUN_EXTENSION)) {
    return fromFile(text);
  }

  return id(text);
};

export const describeSelector = (selector: Selector) =>
  $match(selector, {
    Baseline: ({ branch }) =>
      Option.match(branch, {
        onNone: () => "the baseline on the base branch",
        onSome: (name) => `the baseline on ${name}`,
      }),
    Branch: ({ branch }) => `the latest run on ${branch}`,
    File: ({ path }) => path,
    Id: (wanted) => `run ${wanted.id}`,
    Latest: () => "the latest run",
  });

const entryOf = (events: readonly EvalEvent[]): Option.Option<IndexEntry> =>
  Option.map(Option.fromNullishOr(events.find(Events.isRunStarted)), (started) => {
    const finished = Option.fromNullishOr(events.find(Events.isRunFinished));

    return {
      branch: started.git.branch,
      dirty: started.git.dirty,
      eval: started.eval,
      id: started.runId,
      interrupted: Option.match(finished, {
        onNone: () => true,
        onSome: (event) => event.interrupted,
      }),
      passed: Option.exists(finished, (event) => event.passed),
      rescoreOf: started.rescoreOf,
      sha: started.git.sha,
      startedAt: started.at,
      trials: started.trials,
      variants: started.variants,
    };
  });

const newestFirst = (entries: readonly IndexEntry[]) =>
  entries
    .toReversed()
    .toSorted(Order.mapInput(Order.flip(DateTime.Order), (entry: IndexEntry) => entry.startedAt));

const historyError = (message: string) => (cause: unknown) =>
  new EvalHistoryError({ cause, message });

export const load = Effect.fn("History.load")(function* loadRun(
  evalName: string,
  selector: Selector,
  options: { readonly variant?: string; readonly excluding?: string } = {},
) {
  const history = yield* History;

  if ($is("File")(selector)) {
    return yield* history.file(selector.path).pipe(Effect.flatMap(fold), Effect.tap(exposing));
  }

  const entries = newestFirst(yield* history.index(evalName)).filter(
    (entry) =>
      entry.id !== options.excluding &&
      (options.variant === undefined || entry.variants.includes(options.variant)),
  );

  const base = yield* baseBranch;
  const exact = $is("Id")(selector) ? entries.filter((entry) => entry.id === selector.id) : [];

  const candidates =
    exact.length > 0
      ? exact
      : entries.filter((entry) =>
          $match(selector, {
            Baseline: ({ branch }) =>
              !entry.interrupted &&
              Option.contains(
                entry.branch,
                Option.getOrElse(branch, () => base),
              ) &&
              Option.isNone(entry.rescoreOf),
            Branch: ({ branch }) => !entry.interrupted && Option.contains(entry.branch, branch),
            File: () => false,
            Id: (wanted) => entry.id.startsWith(wanted.id),
            Latest: () => !entry.interrupted,
          }),
        );

  if ($is("Id")(selector) && candidates.length > 1) {
    return yield* new EvalHistoryError({
      message: `The id ${selector.id} matches ${String(candidates.length)} runs of ${evalName}: ${candidates
        .map((entry) => entry.id)
        .toSorted()
        .join(", ")}.`,
    });
  }

  const [chosen] = candidates;

  if (chosen === undefined) {
    return yield* new EvalHistoryError({
      message: `No run of ${evalName} matches ${describeSelector(selector)}.`,
    });
  }

  return yield* history
    .events(evalName, chosen.id)
    .pipe(Effect.flatMap(fold), Effect.tap(exposing));
});

export type ResolvedBaseline = readonly [selector: Selector, run: Option.Option<Run>];

export const ResolvedBaselines = Context.Reference<readonly ResolvedBaseline[]>(
  "effect-eval/ResolvedBaselines",
  { defaultValue: () => [] },
);

export const ReportBaseline = Context.Reference<Option.Option<Selector>>(
  "effect-eval/ReportBaseline",
  { defaultValue: () => Option.none() },
);

export const resolve = Effect.fn("History.resolve")(function* resolveBaseline(
  evalName: string,
  selector: Selector,
  variants: readonly string[],
  options: { readonly excluding?: string } = {},
) {
  if ($is("File")(selector) || $is("Id")(selector)) {
    return yield* load(evalName, selector, options);
  }

  const found = yield* pipe(
    variants,
    Effect.forEach((variant) =>
      load(evalName, selector, { ...options, variant }).pipe(
        Effect.option,
        Effect.map(Option.map((run) => [variant, run] as const)),
      ),
    ),
  );

  const pairs = found.flatMap((entry) => Option.toArray(entry));
  const [first] = pairs;

  if (first === undefined) {
    return yield* new EvalHistoryError({
      message: `No run of ${evalName} with ${variants.join(", ")} matches ${describeSelector(selector)}.`,
    });
  }

  const sources = [...new Map(pairs.map(([, run]) => [run.id, run])).values()];

  const combined: Run = {
    ...first[1],
    gates: pairs.flatMap(([variant, run]) => run.gates.filter((gate) => gate.variant === variant)),
    id: sources.map((run) => run.id).join(" + "),
    outputs: pairs.flatMap(([variant, run]) =>
      run.outputs.filter((output) => output.variant === variant),
    ),
    passed: sources.every((run) => run.passed),
    sensitive: sources.some((run) => run.sensitive),
    trials: Math.max(...sources.map((run) => run.trials)),
    variants: pairs.flatMap(([variant, run]) =>
      run.variants.filter((entry) => entry.variant === variant),
    ),
  };

  return combined;
});

export const list = Effect.fn("History.list")(function* listRuns(evalName: string) {
  const history = yield* History;

  return newestFirst(yield* history.index(evalName));
});

export const snapshot = Effect.fn("History.snapshot")(function* snapshotOf(
  run: Run,
  options: { readonly recent?: number; readonly baseBranch?: string } = {},
) {
  const service = yield* Effect.serviceOption(History);

  if (Option.isNone(service)) {
    return emptyHistory;
  }

  const history = service.value;
  const redacts = yield* RedactsSensitive;

  const shown = (loaded: Run) =>
    redacts && loaded.sensitive
      ? Effect.succeed(redactRun(loaded))
      : exposing(loaded).pipe(Effect.as(loaded));

  const loadEntry = (entry: IndexEntry) =>
    history
      .events(run.eval, entry.id)
      .pipe(Effect.flatMap(fold), Effect.flatMap(shown), Effect.option);

  const entries = yield* history.index(run.eval).pipe(
    Effect.map((all) => newestFirst(all.filter((entry) => entry.id !== run.id))),
    Effect.orElseSucceed((): readonly IndexEntry[] => []),
  );

  const wanted = Option.getOrElse(yield* ReportBaseline, () =>
    options.baseBranch === undefined ? baseline() : baseline(options.baseBranch),
  );

  const given = (yield* ResolvedBaselines).find(([selector]) => Equal.equals(selector, wanted));

  const chosen =
    given === undefined
      ? yield* resolve(
          run.eval,
          wanted,
          run.variants.map((variant) => variant.variant),
          { excluding: run.id },
        ).pipe(Effect.provideService(History, history), Effect.option)
      : given[1];

  const baselineRun = yield* Option.match(chosen, {
    onNone: () => Effect.succeedNone,
    onSome: (loaded) => shown(loaded).pipe(Effect.map(Option.some)),
  });

  const recentRuns = yield* pipe(
    entries.slice(0, options.recent ?? DEFAULT_RECENT),
    Effect.forEach(loadEntry),
  );

  const result: HistorySnapshot = {
    baseline: baselineRun,
    recent: recentRuns.flatMap((found) => Option.toArray(found)),
  };

  return result;
});

export const reporter: Reporter.Reporter<EvalHistoryError, History> = Reporter.fromStream(
  "history",
  (events) =>
    Effect.gen(function* writeHistory() {
      const history = yield* History;
      const collected = yield* Stream.runCollect(events);
      yield* history.save(collected);
    }),
  { acceptsSensitive: true },
);

const memoryKey = (evalName: string, runId: string) => `${evalName}/${runId}`;

export const layerMemory = Layer.effect(
  History,
  Effect.gen(function* makeMemoryHistory() {
    const runs = yield* Ref.make<ReadonlyMap<string, readonly EvalEvent[]>>(new Map());

    return {
      events: (evalName, runId) =>
        Ref.get(runs).pipe(
          Effect.flatMap((stored) =>
            Option.match(Option.fromNullishOr(stored.get(memoryKey(evalName, runId))), {
              onNone: () =>
                Effect.fail(new EvalHistoryError({ message: `No run ${runId} of ${evalName}.` })),
              onSome: Effect.succeed,
            }),
          ),
        ),
      file: (path) =>
        Effect.fail(new EvalHistoryError({ message: `The memory history cannot read ${path}.` })),
      index: (evalName) =>
        Ref.get(runs).pipe(
          Effect.map((stored) =>
            [...stored.values()]
              .flatMap((events) => Option.toArray(entryOf(events)))
              .filter((entry) => entry.eval === evalName),
          ),
        ),
      save: (events) =>
        Option.match(entryOf(events), {
          onNone: () => Effect.void,
          onSome: (entry) =>
            Ref.update(
              runs,
              (stored) => new Map([...stored, [memoryKey(entry.eval, entry.id), events]]),
            ),
        }),
    };
  }),
);

const IndexLine = Schema.fromJsonString(IndexEntrySchema);

export const layerFileSystem = (root: string = DEFAULT_ROOT) =>
  Layer.effect(
    History,
    Effect.gen(function* makeFileHistory() {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const indexLock = yield* Semaphore.make(1);
      const folderOf = (evalName: string) => paths.join(root, evalName);

      const readLines = (file: string) =>
        fs.readFileString(file).pipe(
          Effect.map((text) => text.split(LINE_BREAK).filter((line) => line.trim().length > 0)),
          Effect.mapError(historyError(`The history file ${file} cannot be read.`)),
        );

      const decodeRun = (file: string) =>
        readLines(file).pipe(
          Effect.flatMap(
            Effect.forEach((line) =>
              Events.decodeLine(line).pipe(
                Effect.mapError(
                  historyError(
                    `${file} has an event that does not decode: a run of another events version?`,
                  ),
                ),
              ),
            ),
          ),
        );

      return {
        events: (evalName, runId) =>
          decodeRun(paths.join(folderOf(evalName), `${runId}${RUN_EXTENSION}`)),
        file: decodeRun,
        index: (evalName) => {
          const file = paths.join(folderOf(evalName), INDEX_FILE);

          return fs.exists(file).pipe(
            Effect.mapError(historyError(`The history index ${file} cannot be read.`)),
            Effect.flatMap((exists) =>
              exists
                ? readLines(file).pipe(
                    Effect.flatMap(
                      Effect.forEach((line) =>
                        Schema.decodeUnknownEffect(IndexLine)(line).pipe(
                          Effect.mapError(
                            historyError(`The history index ${file} does not decode.`),
                          ),
                        ),
                      ),
                    ),
                  )
                : Effect.succeed([]),
            ),
          );
        },
        save: (events) =>
          Option.match(entryOf(events), {
            onNone: () => Effect.void,
            onSome: (entry) =>
              Effect.gen(function* saveRun() {
                const folder = folderOf(entry.eval);
                yield* fs.makeDirectory(folder, { recursive: true });

                const lines = yield* pipe(
                  events,
                  Effect.forEach((event) => Events.encodeLine(event)),
                );

                yield* fs.writeFileString(
                  paths.join(folder, `${entry.id}${RUN_EXTENSION}`),
                  `${lines.join(LINE_BREAK)}${LINE_BREAK}`,
                );
                const indexLine = yield* Schema.encodeEffect(IndexLine)(entry);
                yield* fs
                  .writeFileString(paths.join(folder, INDEX_FILE), `${indexLine}${LINE_BREAK}`, {
                    flag: "a",
                  })
                  .pipe((write) => indexLock.withPermit(write));
              }).pipe(Effect.mapError(historyError(`The run ${entry.id} cannot be saved.`))),
          }),
      };
    }),
  );
