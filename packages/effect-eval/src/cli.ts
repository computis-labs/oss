import { Array as Arr, Console, Effect, Layer, Logger, Option, pipe } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import * as EvalConfig from "./config.ts";
import type { FilterOptions, SampleOptions } from "./dataset.ts";
import type { Eval } from "./eval.ts";
import * as Gate from "./gate.ts";
import { EvalConfigError } from "./errors/eval-config-error.ts";
import * as Git from "./git.ts";
import * as History from "./history.ts";
import * as Metric from "./metric.ts";
import * as Reporter from "./reporter.ts";
import * as Runner from "./runner.ts";
import type { Run } from "./run.ts";
import type { Variant } from "./variant.ts";
import * as View from "./view.ts";
import * as ViewText from "./view-text.ts";

export const formats = {
  json: "json",
  markdown: "markdown",
  text: "text",
} as const;
export type Format = (typeof formats)[keyof typeof formats];

const SAMPLE_SEPARATOR = ":";
const DEFAULT_SEED = "effect-eval";
const DEFAULT_LIMIT = 20;
const CWD = ".";
const SHA_LENGTH = 7;
const TABLE_WIDTH = 120;
const ACCURACY_DIGITS = 2;
const NOT_MEASURED = "—";

export const parseSample = (text: string): Option.Option<SampleOptions> => {
  const [size, seed] = text.split(SAMPLE_SEPARATOR);
  const parsed = Number(size);
  return Number.isInteger(parsed) && parsed > 0
    ? Option.some({ seed: seed ?? DEFAULT_SEED, size: parsed })
    : Option.none();
};

const formatFlag = Flag.Literals("format", [formats.text, formats.json, formats.markdown]).pipe(
  Flag.withDescription("Alias of --reporter on stdout: text, json or markdown."),
  Flag.optional,
);

const reporterFlag = Flag.String("reporter").pipe(
  Flag.withDescription(
    "A built-in reporter (terminal, html, markdown, json, silent, history) or the path of a module that exports a Reporter. Repeat it for more.",
  ),
  Flag.atLeast(0),
);

const runFlags = {
  baseline: Flag.String("baseline").pipe(
    Flag.withDescription(
      "Compare with a stored run and fail on regressions: an id, latest, baseline or a JSONL file.",
    ),
    Flag.optional,
  ),
  case: Flag.String("case").pipe(Flag.withDescription("Run only this case."), Flag.atLeast(0)),
  concurrency: Flag.Int("concurrency").pipe(
    Flag.withDescription("Concurrent task calls."),
    Flag.optional,
  ),
  format: formatFlag,
  limit: Flag.Int("limit").pipe(
    Flag.withDescription("Run at most this many cases."),
    Flag.optional,
  ),
  noHistory: Flag.Boolean("no-history").pipe(
    Flag.withDescription("Keep the run out of the history."),
    Flag.withDefault(false),
  ),
  reporter: reporterFlag,
  rescore: Flag.String("rescore").pipe(
    Flag.withDescription("Score the outputs of a stored run again: an id, latest or baseline."),
    Flag.optional,
  ),
  sample: Flag.String("sample").pipe(
    Flag.withDescription("Run a seeded sample of the cases: <size>[:<seed>]."),
    Flag.filterMap(parseSample, (text) => `Expected <size>[:<seed>], got ${text}`),
    Flag.optional,
  ),
  tag: Flag.String("tag").pipe(
    Flag.withDescription("Run only the cases with this tag."),
    Flag.atLeast(0),
  ),
  trials: Flag.Int("trials").pipe(
    Flag.withDescription("Repeat every case this many times per variant."),
    Flag.filterMap(
      (count) => Option.liftPredicate(count, (value) => value > 0),
      (count) => `Expected a positive number of trials, got ${String(count)}`,
    ),
    Flag.optional,
  ),
  variant: Flag.String("variant").pipe(
    Flag.withDescription("Run this variant. Repeat it for more."),
    Flag.atLeast(0),
  ),
  yes: Flag.Boolean("yes").pipe(
    Flag.withDescription("Confirm a plan above the confirmation budget."),
    Flag.withDefault(false),
  ),
};

export type CustomValues<Flags extends Command.Command.FlagConfig> = Command.Command.Config.Infer<{
  readonly custom: Flags;
}>["custom"];

export interface CommandOptions<
  A,
  O,
  E,
  DE,
  R,
  Flags extends Command.Command.FlagConfig,
  ROut,
  VE,
  RIn,
  DR = never,
  SR = never,
> {
  readonly name: string;
  readonly evalName?: string;
  readonly flags?: Flags;
  readonly eval: (flags: CustomValues<Flags>) => Eval<A, O, E, DE, R, DR, SR>;
  readonly variants: {
    readonly parse: (name: string) => Variant<ROut, VE, RIn>;
    readonly defaults: readonly string[];
  };
}

const loadConfig = EvalConfig.load(CWD).pipe(
  Effect.map(Option.getOrElse((): EvalConfig.EvalConfig => ({}))),
);

const nonEmpty = (values: readonly string[]) =>
  Option.liftPredicate(values, Arr.isReadonlyArrayNonEmpty);

const logsToStderr = Layer.succeed(Logger.LogToStderr, true);

export const formatted = (
  reporters: readonly EvalConfig.ConfiguredReporter[],
  format: Option.Option<Format>,
  config: EvalConfig.EvalConfig = {},
): readonly EvalConfig.ConfiguredReporter[] =>
  Option.match(format, {
    onNone: () => reporters,
    onSome: (chosen) => [
      ...reporters.filter((reporter) => reporter.destination !== Reporter.destinations.stdout),
      ...Option.toArray(
        EvalConfig.builtin(
          {
            [formats.json]: EvalConfig.builtinNames.json,
            [formats.markdown]: EvalConfig.builtinNames.markdown,
            [formats.text]: EvalConfig.builtinNames.terminal,
          }[chosen],
          config,
        ),
      ),
    ],
  });

export const command = <
  A,
  O,
  E,
  DE,
  R,
  const Flags extends Command.Command.FlagConfig = Record<never, never>,
  ROut = never,
  VE = never,
  RIn = never,
  DR = never,
  SR = never,
>(
  options: CommandOptions<A, O, E, DE, R, Flags, ROut, VE, RIn, DR, SR>,
) => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: without flags, Flags stays its default, the empty record.
  const customFlags = options.flags ?? ({} as Flags);
  const evalNameOf = (custom: CustomValues<Flags>) => options.evalName ?? options.eval(custom).name;
  const resolveReporters = (
    flags: {
      readonly reporter: readonly string[];
      readonly format: Option.Option<Format>;
      readonly noHistory: boolean;
    },
    config: EvalConfig.EvalConfig,
  ) =>
    Effect.gen(function* resolveAll() {
      const chosen: readonly EvalConfig.ReporterEntry[] =
        flags.reporter.length > 0
          ? flags.reporter
          : (config.reporters ?? EvalConfig.defaultReporters);
      const historyOn = !flags.noHistory && EvalConfig.historyEnabled(config);
      const kept = chosen.filter((entry) => historyOn || entry !== EvalConfig.builtinNames.history);
      const resolved = yield* pipe(
        [...new Set(kept)],
        Effect.forEach((entry) => EvalConfig.resolveReporter(entry, { config, cwd: CWD })),
      );
      return EvalConfig.withoutHistory(formatted(resolved, flags.format, config), historyOn);
    });
  const runCommand = Command.make(
    options.name,
    { custom: customFlags, run: runFlags },
    ({ custom, run: flags }) =>
      Effect.gen(function* runEval() {
        const config = yield* loadConfig;
        const historyServices = EvalConfig.historyLayer(config);
        const baseline = flags.baseline.pipe(Option.map((text) => History.parseSelector(text)));
        const defined = options.eval(custom);
        if (options.evalName !== undefined && options.evalName !== defined.name) {
          return yield* new EvalConfigError({
            message: `evalName is ${options.evalName}, but the eval is named ${defined.name}; leave evalName out or make them match.`,
            path: "evalName",
          });
        }
        const source = yield* Option.match(flags.rescore, {
          onNone: () => Effect.succeed(Option.none<Run>()),
          onSome: (text) =>
            History.load(defined.name, History.parseSelector(text)).pipe(
              Effect.provide(historyServices),
              Effect.map(Option.some),
            ),
        });
        const names = [
          ...new Set(
            flags.variant.length > 0
              ? flags.variant
              : Option.match(source, {
                  onNone: () => options.variants.defaults,
                  onSome: (stored) => stored.variants.map((variant) => variant.variant),
                }),
          ),
        ];
        const resolved = yield* Option.match(baseline, {
          onNone: () => Effect.succeed<readonly Runner.ResolvedBaseline[]>([]),
          onSome: (selector) =>
            History.resolve(defined.name, selector, names).pipe(
              Effect.provide(historyServices),
              Effect.option,
              Effect.map((found): readonly Runner.ResolvedBaseline[] => [[selector, found]]),
            ),
        });
        const self = Option.match(baseline, {
          onNone: () => defined,
          onSome: (selector) => ({
            ...defined,
            gates: [...defined.gates, Gate.noRegressions(selector)],
          }),
        });
        const filter: FilterOptions = {
          ...Option.match(nonEmpty(flags.case), { onNone: () => ({}), onSome: (ids) => ({ ids }) }),
          ...Option.match(nonEmpty(flags.tag), {
            onNone: () => ({}),
            onSome: (tags) => ({ tags }),
          }),
          ...Option.match(flags.limit, { onNone: () => ({}), onSome: (limit) => ({ limit }) }),
        };
        const selection = {
          filter,
          ...Option.match(flags.sample, { onNone: () => ({}), onSome: (sample) => ({ sample }) }),
        };
        const reporters = yield* resolveReporters(flags, config);
        const services = Reporter.layer(reporters).pipe(
          Layer.provideMerge(historyServices),
          Layer.merge(Git.layerProcess),
        );
        const trials = Option.match(flags.trials, {
          onNone: () => ({}),
          onSome: (count) => ({ trials: count }),
        });
        const comparing = {
          baselines: resolved,
          ...Option.match(baseline, {
            onNone: () => ({}),
            onSome: (reportBaseline) => ({ reportBaseline }),
          }),
        };
        const run = Option.isSome(source)
          ? yield* Runner.rescoreRun(self, source.value, {
              ...selection,
              ...comparing,
              ...Option.match(nonEmpty(flags.variant), {
                onNone: () => ({}),
                onSome: () => ({ variants: names }),
              }),
            }).pipe(Effect.provide(services))
          : yield* Effect.gen(function* liveRun() {
              const variants = names.map(options.variants.parse);
              const planned = yield* Runner.plan(self, {
                ...selection,
                ...trials,
                variants: variants.length,
              });
              yield* Console.error(
                `${self.name}: ${String(planned.cases)} cases (${String(planned.skipped)} skipped) × ${String(planned.variants)} variants × ${String(planned.trials)} trials = ${String(planned.invocations)} task calls`,
              );
              return yield* Runner.run(self, {
                ...selection,
                ...trials,
                ...comparing,
                confirmed: flags.yes,
                variants,
                ...Option.match(flags.concurrency, {
                  onNone: () => ({}),
                  onSome: (concurrency) => ({ concurrency }),
                }),
              });
            }).pipe(Effect.provide(services));
        yield* Effect.forEach(
          resolved.flatMap(([, found]) => Option.toArray(found)),
          (base) => Reporter.compare(base, run).pipe(Effect.provide(services)),
          { discard: true },
        );
        return yield* Runner.check(run);
      }),
  ).pipe(Command.provide(logsToStderr));
  const historyCommand = Command.make(
    "history",
    {
      custom: customFlags,
      list: {
        branch: Flag.String("branch").pipe(
          Flag.withDescription("Only runs of this branch."),
          Flag.optional,
        ),
        limit: Flag.Int("limit").pipe(Flag.withDefault(DEFAULT_LIMIT)),
        variant: Flag.String("variant").pipe(
          Flag.withDescription("Only runs with this variant."),
          Flag.optional,
        ),
      },
    },
    ({ custom, list: flags }) =>
      Effect.gen(function* listHistory() {
        const config = yield* loadConfig;
        const historyServices = EvalConfig.historyLayer(config);
        const evalName = evalNameOf(custom);
        const entries = yield* History.list(evalName).pipe(Effect.provide(historyServices));
        const shown = entries
          .filter((entry) =>
            Option.match(flags.branch, {
              onNone: () => true,
              onSome: (branch) => Option.contains(entry.branch, branch),
            }),
          )
          .filter((entry) =>
            Option.match(flags.variant, {
              onNone: () => true,
              onSome: (variant) => entry.variants.includes(variant),
            }),
          )
          .slice(0, flags.limit);
        const accuracies = yield* pipe(
          shown,
          Effect.forEach((entry) =>
            History.load(evalName, History.id(entry.id)).pipe(
              Effect.map((run) =>
                run.variants
                  .map(
                    (variant) =>
                      `${variant.variant} ${Option.match(
                        Option.flatMap(
                          Option.fromNullishOr(variant.summary.ratios[Metric.accuracy.name]),
                          (estimate) => estimate.value,
                        ),
                        {
                          onNone: () => NOT_MEASURED,
                          onSome: (value) => value.toFixed(ACCURACY_DIGITS),
                        },
                      )}`,
                  )
                  .join(", "),
              ),
              Effect.orElseSucceed(() => ""),
            ),
          ),
          Effect.provide(historyServices),
        );
        const text = yield* ViewText.render(
          [
            View.table(
              ["id", "started", "branch", "sha", "variants", "trials", "accuracy", "result"],
              shown.map((entry, index) => [
                entry.id,
                entry.startedAt.toString(),
                Option.getOrElse(entry.branch, () => ""),
                entry.sha.pipe(
                  Option.map((sha) => sha.slice(0, SHA_LENGTH)),
                  Option.getOrElse(() => ""),
                ),
                entry.variants.join(", "),
                String(entry.trials),
                accuracies[index] ?? "",
                View.outcomeLabel(entry),
              ]),
            ),
          ],
          { color: false, width: TABLE_WIDTH },
        );
        yield* Console.log(text);
      }),
  ).pipe(
    Command.withDescription("List the stored runs. No task calls."),
    Command.provide(logsToStderr),
  );
  const compareCommand = Command.make(
    "compare",
    {
      compared: {
        base: Argument.String("base"),
        format: formatFlag,
        head: Argument.String("head"),
        reporter: reporterFlag,
      },
      custom: customFlags,
    },
    ({ compared: flags, custom }) =>
      Effect.gen(function* compareRuns() {
        const config = yield* loadConfig;
        const historyServices = EvalConfig.historyLayer(config);
        const evalName = evalNameOf(custom);
        const [base, head] = yield* History.load(evalName, History.parseSelector(flags.head)).pipe(
          Effect.flatMap((loaded) =>
            History.resolve(
              evalName,
              History.parseSelector(flags.base),
              loaded.variants.map((variant) => variant.variant),
            ).pipe(Effect.map((resolvedBase) => [resolvedBase, loaded] as const)),
          ),
          Effect.provide(historyServices),
        );
        const reporters = yield* resolveReporters({ ...flags, noHistory: true }, config);
        yield* Reporter.compare(base, head).pipe(
          Effect.provide(Reporter.layer(reporters).pipe(Layer.provideMerge(historyServices))),
        );
      }),
  ).pipe(
    Command.withDescription("Compare two stored runs through the chosen reporters. No task calls."),
    Command.provide(logsToStderr),
  );
  return runCommand.pipe(Command.withSubcommands([historyCommand, compareCommand]));
};
