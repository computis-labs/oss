import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer, Option, Path, pipe } from "effect";
import * as EvalConfig from "../src/config.ts";
import * as Dataset from "../src/dataset.ts";
import { EvalConfigError } from "../src/errors/eval-config-error.ts";
import * as Eval from "../src/eval.ts";
import * as Git from "../src/git.ts";
import * as History from "../src/history.ts";
import * as Reporter from "../src/reporter.ts";
import * as Runner from "../src/runner.ts";
import * as Scorer from "../src/scorer.ts";
import * as View from "../src/view.ts";
import { runOf } from "./fixtures.ts";

const categorizer = Eval.make({
  dataset: Dataset.fromIterable(["rent"], { id: (id: string) => id }),
  name: "categorizer",
  score: Scorer.label<string, string>({ actual: Option.some, expected: Scorer.present }),
  task: (input) => Effect.succeed(input.input),
});

const inTempFolder = <A, E, R>(
  use: (folder: string) => Effect.Effect<A, E, R>,
  options: { readonly directory?: string } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const folder = yield* fs.makeTempDirectoryScoped(options);
    return yield* use(folder);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const writeFile = (path: string, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    yield* fs.makeDirectory(paths.dirname(path), { recursive: true });
    yield* fs.writeFileString(path, text);
  });

const reporterNamesFrom = (cwd: string) =>
  Effect.gen(function* () {
    const config = Option.getOrElse(yield* EvalConfig.load(cwd), (): EvalConfig.EvalConfig => ({}));
    const reporters = yield* pipe(
      config.reporters ?? [],
      Effect.forEach((entry) => EvalConfig.resolveReporter(entry, { config, cwd })),
    );
    return reporters.map((reporter) => reporter.name);
  });

const sink = (file: string) => [
  "-e",
  `require("fs").writeFileSync(${JSON.stringify(file)}, require("fs").readFileSync(0, "utf8"))`,
];

const reporterModule = `export default {
  acceptsSensitive: false,
  consume: () => undefined,
  delivery: "all",
  name: "slack",
  required: true,
};
`;

const comparingReporter = `{
  acceptsSensitive: false,
  compare: () => Effect.fail("compared"),
  consume: () => Effect.void,
  delivery: "all",
  name: "custom",
  required: true,
}`;

describe("EvalConfig keeps every field of a custom reporter", () => {
  it.effect("delivers comparisons to a reporter from a module and from the config", () =>
    inTempFolder(
      (folder) =>
        Effect.gen(function* () {
          yield* writeFile(
            `${folder}/reporters/custom.mjs`,
            `import { Effect } from "effect";\nexport default ${comparingReporter};\n`,
          );
          yield* writeFile(
            `${folder}/eval.config.mjs`,
            `import { Effect } from "effect";\nexport default { reporters: [${comparingReporter}] };\n`,
          );
          const run = yield* Runner.run(categorizer);
          const fromModule = yield* EvalConfig.resolveReporter("reporters/custom.mjs", {
            cwd: folder,
          });
          const config = yield* EvalConfig.load(folder);
          const fromConfig = yield* pipe(
            Option.getOrElse(config, (): EvalConfig.EvalConfig => ({})).reporters ?? [],
            Effect.forEach((entry) => EvalConfig.resolveReporter(entry, { cwd: folder })),
          );

          const failures = yield* pipe(
            [[fromModule], fromConfig],
            Effect.forEach((reporters) =>
              Effect.flip(
                Reporter.compare(run, run).pipe(
                  Effect.provide(Reporter.layer(reporters)),
                  Effect.provide(History.layerMemory),
                ),
              ),
            ),
          );

          expect(failures).toMatchObject([{ reporter: "custom" }, { reporter: "custom" }]);
        }),
      { directory: import.meta.dirname },
    ),
  );
});

describe("EvalConfig.builtin", () => {
  it("knows every built-in reporter by name", () => {
    expect(
      Object.values(EvalConfig.builtinNames).map((name) =>
        Option.map(EvalConfig.builtin(name), (reporter) => reporter.name),
      ),
    ).toEqual(Object.values(EvalConfig.builtinNames).map(Option.some));
  });

  it("knows no other name", () => {
    expect(EvalConfig.builtin("slack")).toEqual(Option.none());
  });
});

describe("EvalConfig.resolveReporter", () => {
  it.effect(
    "builds a built-in reporter from a name and its options, with the View of the config",
    () =>
      inTempFolder((folder) =>
        Effect.gen(function* () {
          const config = EvalConfig.define({
            view: () => [View.Text({ text: "the view of the config", tone: "neutral" })],
          });
          const reporters = yield* pipe(
            [
              ["markdown", { file: `${folder}/report.md` }],
              ["json", { file: `${folder}/run.jsonl` }],
            ] as const,
            Effect.forEach((entry) => EvalConfig.resolveReporter(entry, { config, cwd: folder })),
          );

          yield* Runner.run(categorizer).pipe(
            Effect.provide(Reporter.layer(reporters)),
            Effect.provide(History.layerMemory),
          );
          const fs = yield* FileSystem.FileSystem;

          expect(yield* fs.readFileString(`${folder}/report.md`)).toContain(
            "the view of the config",
          );
          expect(yield* fs.readFileString(`${folder}/run.jsonl`)).toContain('"RunFinished"');
        }),
      ),
  );

  it.effect(
    "writes a comparison to the compareFile of a file reporter, apart from its report",
    () =>
      inTempFolder((folder) =>
        Effect.gen(function* () {
          const reporter = yield* EvalConfig.resolveReporter(
            ["html", { compareFile: `${folder}/diff.html`, file: `${folder}/report.html` }],
            { cwd: folder },
          );
          const layer = Reporter.layer([reporter]);

          const base = yield* Runner.run(categorizer).pipe(Effect.provide(layer));
          yield* Reporter.compare(base, base).pipe(Effect.provide(layer));
          const fs = yield* FileSystem.FileSystem;

          expect(yield* fs.readFileString(`${folder}/report.html`)).toContain("Summary");
          expect(yield* fs.readFileString(`${folder}/diff.html`)).toContain("0 regressions");
        }).pipe(Effect.provide(History.layerMemory)),
      ),
  );

  it.effect("runs a process reporter given as a value and as a process tuple", () =>
    inTempFolder((folder) =>
      Effect.gen(function* () {
        const config = EvalConfig.define({
          reporters: [
            Reporter.process("value", "node", sink(`${folder}/value.jsonl`)),
            ["process", { args: sink(`${folder}/tuple.jsonl`), command: "node", name: "tuple" }],
          ],
        });
        const reporters = yield* pipe(
          config.reporters ?? [],
          Effect.forEach((entry) => EvalConfig.resolveReporter(entry, { config, cwd: folder })),
        );

        yield* Runner.run(categorizer).pipe(
          Effect.provide(Reporter.layer(reporters)),
          Effect.provide(History.layerMemory),
        );
        const fs = yield* FileSystem.FileSystem;

        expect(reporters.map((reporter) => reporter.name)).toEqual(["value", "tuple"]);
        expect(yield* fs.readFileString(`${folder}/value.jsonl`)).toContain('"RunFinished"');
        expect(yield* fs.readFileString(`${folder}/tuple.jsonl`)).toContain('"RunFinished"');
      }),
    ),
  );

  it.effect("refuses a process tuple without a command", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        EvalConfig.resolveReporter(["process", { file: "x" }], { cwd: "." }),
      );

      expect(failure).toBeInstanceOf(EvalConfigError);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses options for a reporter that is not built in", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(EvalConfig.resolveReporter(["slack", {}], { cwd: "." }));

      expect(failure).toBeInstanceOf(EvalConfigError);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("returns a reporter value as it is", () =>
    Effect.gen(function* () {
      expect(yield* EvalConfig.resolveReporter(Reporter.silent, { cwd: "." })).toBe(
        Reporter.silent,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails with EvalConfigError on a name that is neither built in nor a module", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(EvalConfig.resolveReporter("slack", { cwd: "/nowhere" }));

      expect(failure).toMatchObject({
        message: "The module cannot be imported.",
        path: "/nowhere/slack",
      });
      expect(failure).toBeInstanceOf(EvalConfigError);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("imports a reporter module relative to the folder", () =>
    inTempFolder((folder) =>
      Effect.gen(function* () {
        yield* writeFile(`${folder}/reporters/slack.mjs`, reporterModule);

        const reporter = yield* EvalConfig.resolveReporter("reporters/slack.mjs", { cwd: folder });

        expect(reporter).toMatchObject({ name: "slack", required: true });
      }),
    ),
  );

  it.effect("fails when the module does not export a reporter", () =>
    inTempFolder((folder) =>
      Effect.gen(function* () {
        yield* writeFile(`${folder}/slack.mjs`, "export default { name: 'slack' };\n");

        const failure = yield* Effect.flip(
          EvalConfig.resolveReporter("slack.mjs", { cwd: folder }),
        );

        expect(failure.message).toContain("slack.mjs is not a built-in reporter");
      }),
    ),
  );
});

describe("EvalConfig.load", () => {
  it.effect("loads the approved shape: a View callback and reporters with options", () =>
    inTempFolder((folder) =>
      Effect.gen(function* () {
        yield* writeFile(
          `${folder}/eval.config.mjs`,
          `export default {
  reporters: ["terminal", ["html", { file: ".eval/report.html" }], ["json", { file: ".eval/last-run.jsonl" }]],
  history: { directory: ".eval/history", baseBranch: "main" },
  view: () => [],
};\n`,
        );

        const config = yield* EvalConfig.load(folder);

        expect(config.pipe(Option.map((loaded) => loaded.reporters))).toEqual(
          Option.some([
            "terminal",
            ["html", { file: ".eval/report.html" }],
            ["json", { file: ".eval/last-run.jsonl" }],
          ]),
        );
        expect(
          config.pipe(Option.map((loaded) => loaded.view?.(runOf("r1", []), View.emptyHistory))),
        ).toEqual(Option.some([]));
      }),
    ),
  );

  it.effect("finds no config in a folder without one", () =>
    inTempFolder((folder) =>
      Effect.gen(function* () {
        expect(yield* EvalConfig.load(folder)).toEqual(Option.none());
      }),
    ),
  );

  it.effect("loads eval.config.ts from a parent folder", () =>
    inTempFolder((folder) =>
      Effect.gen(function* () {
        yield* writeFile(
          `${folder}/eval.config.ts`,
          `export default { history: { enabled: false, baseBranch: "develop" }, reporters: ["terminal", "json"] };\n`,
        );
        yield* writeFile(`${folder}/apps/backend/.keep`, "");

        const config = yield* EvalConfig.load(`${folder}/apps/backend`);

        expect(config).toEqual(
          Option.some({
            history: { baseBranch: "develop", enabled: false },
            reporters: ["terminal", "json"],
          }),
        );
        expect(config.pipe(Option.map(EvalConfig.historyEnabled))).toEqual(Option.some(false));
      }),
    ),
  );

  it.effect("resolves the reporter modules of a parent config from the folder of that config", () =>
    inTempFolder((folder) =>
      Effect.gen(function* () {
        yield* writeFile(`${folder}/reporters/slack.mjs`, reporterModule);
        yield* writeFile(
          `${folder}/eval.config.mjs`,
          `export default { reporters: ["terminal", "./reporters/slack.mjs"] };\n`,
        );
        yield* writeFile(`${folder}/apps/backend/.keep`, "");
        const child = `${folder}/apps/backend`;

        expect([yield* reporterNamesFrom(folder), yield* reporterNamesFrom(child)]).toEqual([
          ["terminal", "slack"],
          ["terminal", "slack"],
        ]);
      }),
    ),
  );

  it.effect("fails with EvalConfigError when the default export is not a config", () =>
    inTempFolder((folder) =>
      Effect.gen(function* () {
        yield* writeFile(`${folder}/eval.config.mjs`, "export default { reporters: 42 };\n");

        const failure = yield* Effect.flip(EvalConfig.load(folder));

        expect(failure.message).toBe(
          "The default export is not an EvalConfig: export default EvalConfig.define({ … }).",
        );
      }),
    ),
  );
});

describe("EvalConfig.historyEnabled", () => {
  it("keeps the history unless the config turns it off", () => {
    expect([
      EvalConfig.historyEnabled({}),
      EvalConfig.historyEnabled(EvalConfig.define({ history: { enabled: false } })),
    ]).toEqual([true, false]);
  });
});

const baseBranchWith = (config: EvalConfig.EvalConfig, env: Record<string, string>) =>
  History.baseBranch.pipe(
    Effect.provide(EvalConfig.historyLayer(config)),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    Effect.provide(NodeServices.layer),
  );

const savedOn = (branch: string) =>
  Runner.run(
    Eval.make({
      dataset: Dataset.fromIterable(["rent"], { id: (id: string) => id }),
      name: "categorizer",
      score: Scorer.label<string, string>({ actual: Option.some, expected: Scorer.present }),
      task: (input) => Effect.succeed(input.input),
    }),
  ).pipe(
    Effect.provide(
      Layer.merge(
        Reporter.layer([History.reporter]),
        Git.layerStatic({ branch: Option.some(branch), dirty: false, sha: Option.none() }),
      ),
    ),
  );

describe("EvalConfig.historyLayer base branch", () => {
  it.effect("takes the environment first, then the config, then main", () =>
    Effect.gen(function* () {
      const develop = { history: { baseBranch: "develop" } };

      expect(
        yield* Effect.all([
          baseBranchWith(develop, { EVAL_BASE_BRANCH: "release" }),
          baseBranchWith(develop, {}),
          baseBranchWith({}, {}),
        ]),
      ).toEqual(["release", "develop", "main"]);
    }),
  );

  it.effect("picks the baseline of the history snapshot on the configured branch", () =>
    Effect.gen(function* () {
      const onDevelop = yield* savedOn("develop");
      yield* savedOn("main");
      const current = yield* savedOn("feature/x");

      const snapshot = yield* History.snapshot(current).pipe(
        Effect.provideService(History.ConfiguredBaseBranch, Option.some("develop")),
      );

      expect(snapshot.baseline.pipe(Option.map((run) => run.id))).toEqual(
        Option.some(onDevelop.id),
      );
    }).pipe(
      Effect.provide(History.layerMemory),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
    ),
  );
});
