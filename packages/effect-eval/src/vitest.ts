import { afterAll, describe as describeSuite, it } from "@effect/vitest";
import {
  Cause,
  Config,
  Console,
  Duration,
  Effect,
  Equivalence,
  Exit,
  Layer,
  Option,
  pipe,
} from "effect";
import type { FileSystem, Path } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import * as EvalConfig from "./config.ts";
import type { ConfiguredReporter } from "./config.ts";
import type { Dataset } from "./dataset.ts";
import * as Datasets from "./dataset.ts";
import type { Eval } from "./eval.ts";
import * as Gate from "./gate.ts";
import * as Git from "./git.ts";
import * as Reporter from "./reporter.ts";
import * as Reporters from "./reporters.ts";
import type { Run } from "./run.ts";
import * as Runner from "./runner.ts";
import type { Variant } from "./variant.ts";
import * as Variants from "./variant.ts";

const DEFAULT_TIMEOUT = Duration.minutes(30);
const LINE_BREAK = "\n";
const CWD = ".";
const GATES = "gates";

const sameScope = Option.makeEquivalence(Equivalence.String);

export const checkCase = (gates: readonly Gate.Gate[], run: Run, id: string) => {
  const own = Gate.evaluate(
    gates,
    run.variants.map((entry) => ({
      observations: entry.observations.filter((scored) => scored.case === id),
      variant: entry.variant,
    })),
    Gate.noBaselines,
    Number.POSITIVE_INFINITY,
  );
  return Gate.check(
    run.gates
      .filter((gate) => !gate.passed)
      .flatMap((gate) => {
        const recomputed = own.find(
          (result) =>
            result.variant === gate.variant &&
            result.gate === gate.gate &&
            sameScope(result.scope, gate.scope),
        );
        const mine =
          recomputed !== undefined && recomputed.violations.length > 0
            ? recomputed.violations
            : gate.violations.filter((scored) => scored.case === id);
        return mine.length === 0
          ? []
          : [
              {
                ...gate,
                actual: `${String(mine.length)} violations by case ${id}`,
                violations: mine,
              },
            ];
      }),
    { sensitive: run.sensitive },
  );
};

export const splits = {
  case: "case",
  variant: "variant",
} as const;
export type Split = (typeof splits)[keyof typeof splits];

type Resolved<Required> = {
  readonly [K in keyof Required]: Required[K] extends Config.Config<infer T> ? T : never;
};

export interface DescribeOptions<Required, R, ROut, VE, RIn, DR = never> {
  readonly layer: Layer.Layer<
    | Exclude<R, ROut>
    | DR
    | RIn
    | FileSystem.FileSystem
    | Path.Path
    | ChildProcessSpawner.ChildProcessSpawner,
    unknown
  >;
  readonly skipUnless?: Required;
  readonly variants?: (config: Resolved<Required>) => readonly Variant<ROut, VE, RIn>[];
  readonly timeout?: Duration.Input;
  readonly split?: Split;
  readonly reporters?: readonly EvalConfig.ReporterEntry[];
  readonly history?: boolean;
}

const asTestFailure = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(Effect.catchCause((cause) => Effect.fail(new Error(Cause.pretty(cause)))));

export const reportersOf = (
  config: EvalConfig.EvalConfig,
  options: {
    readonly reporters?: readonly EvalConfig.ReporterEntry[];
    readonly history?: boolean;
  },
  write: Reporters.Write,
) => {
  const history = options.history ?? EvalConfig.historyEnabled(config);
  return pipe(
    (options.reporters ?? config.reporters ?? EvalConfig.defaultReporters).filter(
      (entry) => history || entry !== EvalConfig.builtinNames.history,
    ),
    Effect.forEach((entry) =>
      EvalConfig.resolveReporter(entry, { config, cwd: CWD }).pipe(
        Effect.map((reporter): ConfiguredReporter => {
          if (reporter.name === EvalConfig.builtinNames.history) {
            return Reporter.required(reporter);
          }
          return reporter.name === EvalConfig.builtinNames.terminal &&
            reporter.destination === Reporter.destinations.stdout
            ? {
                ...reporter,
                consume: (events) =>
                  reporter
                    .consume(events)
                    .pipe(Effect.provideService(Reporters.TerminalBuffer, Option.some(write))),
              }
            : reporter;
        }),
      ),
    ),
    Effect.map((reporters) => EvalConfig.withoutHistory(reporters, history)),
  );
};

export const describe = <
  A,
  O,
  E,
  DE,
  R,
  DR,
  SR,
  Required extends Readonly<Record<string, Config.Config<unknown>>>,
  ROut = never,
  VE = never,
  RIn = never,
>(
  self: Eval<A, O, E, DE, R, DR, SR>,
  options: DescribeOptions<Required, R | SR, ROut, VE, RIn, DR>,
) => {
  const required = Effect.runSyncExit(Config.all(options.skipUnless ?? {}));
  const missing = Exit.isFailure(required);
  const buffer: string[] = [];
  const write = (text: string) =>
    Effect.sync(() => {
      buffer.push(text);
    });
  const services = Layer.merge(Git.layerProcess.pipe(Layer.provide(options.layer)), options.layer);
  const reportersFor = Effect.gen(function* resolveReporters() {
    const config = Option.getOrElse(yield* EvalConfig.load(CWD), (): EvalConfig.EvalConfig => ({}));
    const reporters = yield* reportersOf(config, options, write);
    return { config, reporters };
  });
  const runVariant = (variant: Variant<ROut, VE, RIn> | Variant<never>) => {
    const provided = Effect.gen(function* runInVitest() {
      const { config, reporters } = yield* reportersFor;
      return yield* Runner.run(self, { variants: [variant] }).pipe(
        Effect.provide(Reporter.layer(reporters)),
        Effect.provide(EvalConfig.historyLayer(config)),
      );
    }).pipe(Effect.provide(services));
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: DescribeOptions makes options.layer provide every service of the eval that the variant does not, so nothing is left to require.
    return provided as Effect.Effect<Run, unknown>;
  };
  const timeout = Duration.toMillis(options.timeout ?? DEFAULT_TIMEOUT);
  const variants: readonly Variant<ROut, VE, RIn>[] | readonly Variant<never>[] = Exit.match(
    required,
    {
      onFailure: () => [Variants.none],
      onSuccess: (config) =>
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: Config.all resolved every config of skipUnless, so each key holds the value of its config.
        options.variants?.(config as Resolved<Required>) ?? [Variants.none],
    },
  );
  const selection = Effect.runSyncExit(
    Runner.validVariants(variants.map((variant) => variant.name)),
  );
  if (Exit.isFailure(selection)) {
    throw Cause.squash(selection.cause);
  }
  describeSuite.skipIf(missing)(self.name, async () => {
    afterAll(() => {
      if (buffer.length > 0) {
        Effect.runSync(Console.log(buffer.join(LINE_BREAK)));
      }
    });
    if (options.split !== splits.case || missing) {
      for (const variant of variants) {
        it.live(
          variant.name,
          () => asTestFailure(runVariant(variant).pipe(Effect.flatMap(Runner.check))),
          timeout,
        );
      }
      return;
    }
    const loaded = await Effect.runPromise(
      Datasets.load(self.dataset).pipe(Effect.provide(options.layer), Effect.orDie),
    );
    for (const variant of variants) {
      const once = Effect.runSync(Effect.cached(runVariant(variant)));
      describeSuite(variant.name, () => {
        for (const input of loaded.cases) {
          it.live(
            input.id,
            () =>
              asTestFailure(
                once.pipe(Effect.flatMap((run) => checkCase(self.gates, run, input.id))),
              ),
            timeout,
          );
        }
        it.live(GATES, () => asTestFailure(once.pipe(Effect.flatMap(Runner.check))), timeout);
      });
    }
  });
};

export const guard = <A, E, R>(
  name: string,
  dataset: Dataset<A, E, R>,
  layer: Layer.Layer<R, unknown>,
) => {
  it.live(`${name}: the dataset passes the privacy guard`, () =>
    asTestFailure(Datasets.load(dataset).pipe(Effect.provide(layer))),
  );
};
