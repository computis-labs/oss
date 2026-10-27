import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Effect,
  Exit,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  PlatformError,
  Schema,
  pipe,
} from "effect";
import { Command, Flag } from "effect/cli";
import { TestConsole } from "effect/testing";
import * as Cli from "../src/cli.ts";
import * as EvalConfig from "../src/config.ts";
import * as Dataset from "../src/dataset.ts";
import * as Eval from "../src/eval.ts";
import * as Events from "../src/events.ts";
import * as Gate from "../src/gate.ts";
import * as History from "../src/history.ts";
import * as Metric from "../src/metric.ts";
import * as Reporter from "../src/reporter.ts";
import * as Reporters from "../src/reporters.ts";
import * as Runner from "../src/runner.ts";
import * as Scorer from "../src/scorer.ts";
import * as Variant from "../src/variant.ts";

const categorizer = Eval.make({
  dataset: Dataset.fromIterable(["rent", "fuel", "food"], {
    id: (label: string) => label,
    tags: (label: string) => [label === "food" ? "kind:rare" : "kind:common"],
  }),
  gates: [Gate.min(Metric.accuracy, 0.9)],
  name: "categorizer",
  score: Scorer.label<string, string>({ actual: Option.some, expected: Scorer.present }),
  task: (input) => Effect.succeed(input.id === "food" ? "rent" : input.input),
});

const cli = Command.runWith(
  Cli.command({
    eval: () => categorizer,
    name: "categorizer",
    variants: { defaults: ["default"], parse: (name) => Variant.make(name, Layer.empty) },
  }),
  { renderErrors: false, version: "0.0.0" },
);

const quiet = ["--reporter", "silent", "--no-history"];

const services = Layer.merge(NodeServices.layer, TestConsole.layer);

describe("Cli.parseSample", () => {
  it("reads a size and an optional seed", () => {
    expect([Cli.parseSample("50"), Cli.parseSample("50:march")]).toEqual([
      Option.some({ seed: "effect-eval", size: 50 }),
      Option.some({ seed: "march", size: 50 }),
    ]);
  });

  it("refuses a size that is not a positive integer", () => {
    expect([Cli.parseSample("0"), Cli.parseSample("2.5"), Cli.parseSample("many")]).toEqual([
      Option.none(),
      Option.none(),
      Option.none(),
    ]);
  });
});

describe("Cli.command", () => {
  it.effect("prints the plan before it runs", () =>
    Effect.gen(function* () {
      yield* cli([...quiet, "--tag", "kind:common"]);

      expect(yield* TestConsole.errorLines).toEqual([
        "categorizer: 2 cases (0 skipped) × 1 variants × 1 trials = 2 task calls",
      ]);
    }).pipe(Effect.provide(services)),
  );

  it.effect("fails when a gate fails", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(cli(quiet));

      expect(failure).toMatchObject({ results: [{ gate: "accuracy ≥ 0.9", passed: false }] });
    }).pipe(Effect.provide(services)),
  );

  it.effect("writes the events as JSON lines with --format json", () =>
    Effect.gen(function* () {
      yield* cli([...quiet, "--format", "json", "--case", "rent"]);

      const lines = yield* TestConsole.logLines;

      const decoded = yield* pipe(
        lines,
        Effect.forEach((line) => Events.decodeLine(String(line))),
      );

      expect(decoded).toMatchObject([
        { _tag: "RunStarted" },
        { _tag: "CaseStarted" },
        { _tag: "CaseFinished" },
        { _tag: "VariantFinished" },
        { _tag: "GateEvaluated" },
        { _tag: "RunFinished" },
      ]);
    }).pipe(Effect.provide(services)),
  );

  it.effect("runs the trials it is asked for", () =>
    Effect.gen(function* () {
      yield* cli([...quiet, "--case", "rent", "--trials", "3"]);

      expect(yield* TestConsole.errorLines).toEqual([
        "categorizer: 1 cases (0 skipped) × 1 variants × 3 trials = 3 task calls",
      ]);
    }).pipe(Effect.provide(services)),
  );
});

const files = new Map<string, string>();

const memoryFileSystem = FileSystem.layerNoop({
  exists: (path) => Effect.sync(() => files.has(path)),
  makeDirectory: () => Effect.void,
  readFileString: (path) =>
    Effect.sync(() => files.get(path) ?? "").pipe(
      Effect.filterOrFail(
        () => files.has(path),
        () =>
          PlatformError.systemError({
            _tag: "NotFound",
            method: "readFileString",
            module: "FileSystem",
            pathOrDescriptor: path,
          }),
      ),
    ),
  writeFileString: (path, data, options) =>
    Effect.sync(() => {
      files.set(path, `${options?.flag === "a" ? (files.get(path) ?? "") : ""}${data}`);
    }),
});

const answering = (answer: (label: string) => string, sensitive = false) =>
  Command.runWith(
    Cli.command({
      eval: () =>
        Eval.make({
          dataset: Dataset.fromIterable(["rent", "fuel"], { id: (label: string) => label }),
          name: "categorizer",
          score: Scorer.label<string, string>({ actual: Option.some, expected: Scorer.present }),
          sensitive,
          task: (input) => Effect.succeed(answer(input.input)),
        }),
      name: "categorizer",
      variants: { defaults: ["default"], parse: (name) => Variant.make(name, Layer.empty) },
    }),
    { renderErrors: false, version: "0.0.0" },
  );

const models = (answer: string) =>
  Command.runWith(
    Cli.command({
      eval: () =>
        Eval.make({
          dataset: Dataset.fromIterable(["rent"], { id: (label: string) => label }),
          name: "categorizer",
          score: Scorer.label<string, string>({ actual: Option.some, expected: Scorer.present }),
          task: () => Effect.succeed(answer),
        }),
      name: "categorizer",
      variants: { defaults: ["a", "b"], parse: (name) => Variant.make(name, Layer.empty) },
    }),
    { renderErrors: false, version: "0.0.0" },
  );

const formattedAsJson = (entries: readonly EvalConfig.ReporterEntry[]) =>
  pipe(
    entries,
    Effect.forEach((entry) => EvalConfig.resolveReporter(entry, { cwd: "." })),
    Effect.map((reporters) =>
      Cli.formatted(reporters, Option.some(Cli.formats.json)).map((reporter) => [
        reporter.name,
        reporter.destination ?? "none",
      ]),
    ),
  );

const freshHistory = Effect.sync(() => {
  files.clear();
});

const IndexLineSchema = Schema.fromJsonString(Schema.Struct({ id: Schema.String }));

const inMemory = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.provide(Layer.mergeAll(memoryFileSystem, Path.layer, TestConsole.layer)),
    Effect.provide(NodeServices.layer),
  );

describe("Cli.command with a history", () => {
  it.effect("compares with the same baseline the gate used, not with the run it just saved", () =>
    inMemory(
      Effect.gen(function* () {
        yield* freshHistory;
        yield* answering((label) => label)(["--reporter", "history"]);

        const failure = yield* Effect.flip(
          answering(() => "rent")([
            "--reporter",
            "history",
            "--reporter",
            "terminal",
            "--baseline",
            "latest",
          ]),
        );

        const printed = (yield* TestConsole.logLines).map(String).join("\n");

        expect(failure).toMatchObject({ results: [{ actual: "1 regressions", passed: false }] });
        expect(printed).toContain("1 regressions, 0 fixes");
      }),
    ),
  );

  it.effect("keeps stdout to JSON lines with --format json and a baseline", () =>
    inMemory(
      Effect.gen(function* () {
        yield* freshHistory;
        yield* answering((label) => label)(["--reporter", "history"]);

        yield* answering(() => "rent")([
          "--reporter",
          "silent",
          "--format",
          "json",
          "--baseline",
          "latest",
        ]).pipe(Effect.ignore);
        const lines = yield* TestConsole.logLines;

        const decoded = yield* pipe(
          lines,
          Effect.forEach((line) => Events.decodeLine(String(line)).pipe(Effect.option)),
        );

        expect(decoded.filter(Option.isNone)).toEqual([]);
        expect(decoded.length).toBeGreaterThan(0);
      }),
    ),
  );

  it.effect("redacts a sensitive comparison in Markdown", () =>
    inMemory(
      Effect.gen(function* () {
        yield* freshHistory;
        yield* answering((label) => label, true)(["--reporter", "history"]);

        yield* answering(
          () => "CUSTOMER_SECRET",
          true,
        )(["--format", "markdown", "--baseline", "latest", "--no-history"]).pipe(Effect.ignore);
        const printed = (yield* TestConsole.logLines).map(String).join("\n");

        expect(printed).toContain("2 regressions");
        expect(printed).not.toContain("CUSTOMER_SECRET");
      }),
    ),
  );

  it.effect("compares two stored runs through the chosen reporter, redacted when sensitive", () =>
    inMemory(
      Effect.gen(function* () {
        yield* freshHistory;
        yield* answering((label) => label, true)(["--reporter", "history"]);
        yield* answering(
          () => "CUSTOMER_SECRET",
          true,
        )(["--reporter", "history"]).pipe(Effect.ignore);

        const [first] = yield* pipe(
          (files.get(".eval/history/categorizer/index.jsonl") ?? "")
            .split("\n")
            .filter((line) => line.length > 0),
          Effect.forEach((line) => Schema.decodeUnknownEffect(IndexLineSchema)(line)),
        );

        yield* answering((label) => label)([
          "compare",
          first?.id ?? "",
          "latest",
          "--reporter",
          "markdown",
        ]);
        const printed = (yield* TestConsole.logLines).map(String).join("\n");

        expect(printed).toContain("2 regressions");
        expect(printed).not.toContain("CUSTOMER_SECRET");
      }),
    ),
  );

  it.effect("keeps a history reporter from a module out of the history with --no-history", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const folder = yield* fs.makeTempDirectoryScoped({ directory: import.meta.dirname });
      const module = `${folder}/history-reporter.mjs`;
      yield* fs.writeFileString(
        module,
        [
          `import { reporter } from "${import.meta.dirname}/../src/history.ts";`,
          `import { required } from "${import.meta.dirname}/../src/reporter.ts";`,
          "export default required(reporter);",
        ].join("\n"),
      );

      const stored = yield* inMemory(
        Effect.gen(function* () {
          yield* freshHistory;
          yield* answering((label) => label)(["--reporter", module, "--no-history"]);
          const off = [...files.keys()];
          yield* answering((label) => label)(["--reporter", module]);

          return [off, [...files.keys()].length > 0];
        }),
      );

      expect(stored).toEqual([[], true]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("replaces a stdout reporter from a module with --format json", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const folder = yield* fs.makeTempDirectoryScoped({ directory: import.meta.dirname });
      const module = `${folder}/terminal-reporter.mjs`;
      yield* fs.writeFileString(
        module,
        [
          `import { terminal } from "${import.meta.dirname}/../src/reporters.ts";`,
          "export default terminal({ color: false });",
        ].join("\n"),
      );

      const lines = yield* inMemory(
        Effect.gen(function* () {
          yield* freshHistory;
          yield* answering((label) => label)([
            "--reporter",
            module,
            "--format",
            "json",
            "--no-history",
          ]);

          return (yield* TestConsole.logLines).map(String);
        }),
      );

      const decoded = yield* pipe(
        lines,
        Effect.forEach((line) => Events.decodeLine(line).pipe(Effect.option)),
      );

      expect(decoded.length).toBeGreaterThan(0);
      expect(decoded.filter(Option.isNone)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rescores a variant the task no longer knows, without parsing it", () =>
    inMemory(
      Effect.gen(function* () {
        yield* freshHistory;
        const parsed: string[] = [];

        const withModels = (known: readonly string[]) =>
          Command.runWith(
            Cli.command({
              eval: () =>
                Eval.make({
                  dataset: Dataset.fromIterable(["rent"], { id: (label: string) => label }),
                  name: "categorizer",
                  output: Schema.String,
                  score: Scorer.label<string, string>({
                    actual: Option.some,
                    expected: Scorer.present,
                  }),
                  task: (input) => Effect.succeed(input.input),
                }),
              name: "categorizer",
              variants: {
                defaults: ["current-model"],
                parse: (name) => {
                  parsed.push(name);

                  if (!known.includes(name)) {
                    throw new Error(`unknown model ${name}`);
                  }

                  return Variant.make(name, Layer.empty);
                },
              },
            }),
            { renderErrors: false, version: "0.0.0" },
          );

        yield* withModels(["retired-model"])([
          "--reporter",
          "history",
          "--variant",
          "retired-model",
        ]);
        parsed.length = 0;

        yield* withModels(["current-model"])([
          "--rescore",
          "latest",
          "--variant",
          "retired-model",
          "--reporter",
          "history",
        ]);

        const index = (files.get(".eval/history/categorizer/index.jsonl") ?? "")
          .split("\n")
          .filter((line) => line.length > 0);

        expect(parsed).toEqual([]);
        expect(index).toHaveLength(2);
      }),
    ),
  );

  it.effect("compares each variant with the baseline its gate used, from single-variant runs", () =>
    inMemory(
      Effect.gen(function* () {
        yield* freshHistory;
        yield* models("rent")(["--variant", "a", "--reporter", "history"]);
        yield* models("rent")(["--variant", "b", "--reporter", "history"]);

        const failure = yield* Effect.flip(
          models("fuel")(["--baseline", "latest", "--reporter", "terminal", "--no-history"]),
        );

        const printed = (yield* TestConsole.logLines).map(String).join("\n");

        expect(failure).toMatchObject({ _tag: "EvalGateFailed" });
        expect(printed.match(/1 regressions, 0 fixes/gu)).toHaveLength(2);
        expect(printed).not.toContain("observations added");
      }),
    ),
  );

  it.effect(
    "keeps one history for the run, history and compare when the command and eval names differ",
    () =>
      inMemory(
        Effect.gen(function* () {
          yield* freshHistory;

          const golden = Command.runWith(
            Cli.command({
              eval: (custom) =>
                Eval.make({
                  dataset: Dataset.fromIterable([custom.pages], { id: (page: string) => page }),
                  name: "autofattura",
                  score: Scorer.label<string, string>({
                    actual: Option.some,
                    expected: Scorer.present,
                  }),
                  task: (input) => Effect.succeed(input.input),
                }),
              flags: { pages: Flag.String("pages").pipe(Flag.withDefault("gennaio-01.pdf")) },
              name: "golden-set",
              variants: {
                defaults: ["default"],
                parse: (name) => Variant.make(name, Layer.empty),
              },
            }),
            { renderErrors: false, version: "0.0.0" },
          );

          yield* golden(["--reporter", "history"]);

          const [entry] = (files.get(".eval/history/autofattura/index.jsonl") ?? "")
            .split("\n")
            .filter((line) => line.length > 0)
            .map((line) => Schema.decodeUnknownSync(IndexLineSchema)(line));

          yield* golden(["history"]);
          const listed = (yield* TestConsole.logLines).map(String).join("\n");

          const compared = yield* Effect.exit(
            golden(["compare", "latest", "latest", "--reporter", "silent"]),
          );

          expect(listed).toContain(entry?.id ?? "no run saved");
          expect(Exit.isSuccess(compared)).toBe(true);
        }),
      ),
  );

  it.effect("refuses an evalName that is not the name of the eval", () =>
    inMemory(
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          Command.runWith(
            Cli.command({
              eval: () =>
                Eval.make({
                  dataset: Dataset.fromIterable(["rent"], { id: (label: string) => label }),
                  name: "autofattura",
                  score: Scorer.label<string, string>({
                    actual: Option.some,
                    expected: Scorer.present,
                  }),
                  task: (input) => Effect.succeed(input.input),
                }),
              evalName: "golden-set",
              name: "golden-set",
              variants: {
                defaults: ["default"],
                parse: (name) => Variant.make(name, Layer.empty),
              },
            }),
            { renderErrors: false, version: "0.0.0" },
          )(["--reporter", "silent"]),
        );

        expect(failure).toMatchObject({ _tag: "EvalConfigError", path: "evalName" });
      }),
    ),
  );

  it.effect("lists the accuracy of each variant in the history", () =>
    inMemory(
      Effect.gen(function* () {
        yield* freshHistory;
        yield* answering((label) => label)(["--reporter", "history"]);
        yield* answering(() => "rent")(["--reporter", "history"]);

        yield* answering((label) => label)(["history"]);

        const rows = (yield* TestConsole.logLines)
          .map(String)
          .join("\n")
          .split("\n")
          .filter((line) => line.includes("default"));

        expect(rows).toHaveLength(2);
        expect(rows[0]).toContain("default 0.50");
        expect(rows[1]).toContain("default 1.00");
      }),
    ),
  );

  it.effect("compares the summary with the --baseline run, not with the default baseline", () =>
    inMemory(
      Effect.gen(function* () {
        yield* freshHistory;
        yield* answering(() => "rent")(["--reporter", "history"]).pipe(Effect.ignore);
        yield* answering((label) => label)(["--reporter", "history"]);

        const [wrong] = yield* pipe(
          (files.get(".eval/history/categorizer/index.jsonl") ?? "")
            .split("\n")
            .filter((line) => line.length > 0),
          Effect.forEach((line) => Schema.decodeUnknownEffect(IndexLineSchema)(line)),
        );

        yield* answering((label) => label)([
          "--reporter",
          "html",
          "--baseline",
          wrong?.id ?? "",
          "--no-history",
        ]);
        const report = files.get(EvalConfig.DEFAULT_HTML) ?? "";

        expect(report).toContain(
          '<td>precision</td><td>1.000 [0.342, 1.000] (n=2)</td><td>2</td><td class="tone-good">+50.0 pt</td>',
        );
      }),
    ),
  );

  it.effect("keeps the run report and writes the baseline comparison to its own HTML file", () =>
    inMemory(
      Effect.gen(function* () {
        yield* freshHistory;
        yield* answering((label) => label)(["--reporter", "history"]);

        yield* answering(() => "rent")([
          "--reporter",
          "html",
          "--baseline",
          "latest",
          "--no-history",
        ]).pipe(Effect.ignore);
        const report = files.get(EvalConfig.DEFAULT_HTML) ?? "";
        const comparison = files.get(".eval/report.compare.html") ?? "";

        expect(report).toContain('<label for="tabs-0-0">Summary</label>');
        expect(comparison).not.toContain("Summary");
        expect(comparison).toContain("1 regressions");
      }),
    ),
  );

  it.effect("writes the comparison to the HTML file when compare uses the html reporter", () =>
    inMemory(
      Effect.gen(function* () {
        yield* freshHistory;
        yield* answering((label) => label)(["--reporter", "history"]);
        yield* answering(() => "rent")(["--reporter", "history"]).pipe(Effect.ignore);

        const [first] = yield* pipe(
          (files.get(".eval/history/categorizer/index.jsonl") ?? "")
            .split("\n")
            .filter((line) => line.length > 0),
          Effect.forEach((line) => Schema.decodeUnknownEffect(IndexLineSchema)(line)),
        );

        yield* answering((label) => label)([
          "compare",
          first?.id ?? "",
          "latest",
          "--reporter",
          "html",
        ]);
        const page = files.get(".eval/report.compare.html") ?? "";

        expect(page).toContain("<html");
        expect(page).toContain("1 regressions");
        expect(files.has(EvalConfig.DEFAULT_HTML)).toBe(false);
      }),
    ),
  );
});

describe("Cli.command output", () => {
  it.effect("runs a variant named twice once", () =>
    Effect.gen(function* () {
      yield* cli([...quiet, "--case", "rent", "--variant", "default", "--variant", "default"]);

      expect(yield* TestConsole.errorLines).toEqual([
        "categorizer: 1 cases (0 skipped) × 1 variants × 1 trials = 1 task calls",
      ]);
    }).pipe(Effect.provide(services)),
  );

  it.effect("writes only JSON lines on stdout with --format json and the default reporters", () =>
    Effect.gen(function* () {
      yield* cli(["--no-history", "--format", "json", "--case", "rent"]).pipe(Effect.ignore);

      const lines = yield* TestConsole.logLines;

      const decoded = yield* pipe(
        lines,
        Effect.forEach((line) => Events.decodeLine(String(line))),
      );

      expect(decoded.length).toBe(lines.length);
      expect(decoded.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(services)),
  );

  it.effect("keeps warnings off stdout with --format json, such as an output it cannot store", () =>
    Effect.gen(function* () {
      const short = Command.runWith(
        Cli.command({
          eval: () =>
            Eval.make({
              dataset: Dataset.fromIterable(["a"], { id: (id: string) => id }),
              name: "short",
              output: Schema.String.check(Schema.isMinLength(3)),
              score: Scorer.label<string, string>({
                actual: Option.some,
                expected: Scorer.present,
              }),
              task: () => Effect.succeed("b"),
            }),
          name: "short",
          variants: { defaults: ["default"], parse: (name) => Variant.make(name, Layer.empty) },
        }),
        { renderErrors: false, version: "0.0.0" },
      );

      yield* short(["--no-history", "--format", "json"]).pipe(
        Effect.provide(Logger.layer([Logger.defaultLogger])),
        Effect.ignore,
      );

      const decoded = yield* pipe(
        yield* TestConsole.logLines,
        Effect.forEach((line) => Events.decodeLine(String(line)).pipe(Effect.option)),
      );

      expect(decoded.filter(Option.isNone)).toEqual([]);
      expect((yield* TestConsole.errorLines).map(String).join("\n")).toContain("unencodable");
    }).pipe(Effect.provide(services)),
  );

  it.effect(
    "replaces built-in stdout reporters given as values with --format, and keeps those that write a file",
    () =>
      inMemory(
        Effect.gen(function* () {
          yield* freshHistory;
          const custom = Reporter.make({ name: "slack" });

          const reporters = Cli.formatted(
            [
              Reporters.terminal({ color: false, progress: false }),
              Reporters.markdown(),
              Reporters.json({ file: "run.jsonl" }),
              Reporter.required(Reporters.markdown({ file: "report.md" })),
              custom,
            ],
            Option.some(Cli.formats.json),
          );

          yield* Runner.run(
            Eval.make({
              dataset: Dataset.fromIterable(["rent"], { id: (label: string) => label }),
              name: "categorizer",
              score: Scorer.label<string, string>({
                actual: Option.some,
                expected: Scorer.present,
              }),
              task: (input) => Effect.succeed(input.input),
            }),
          ).pipe(Effect.provide(Reporter.layer(reporters)));

          const decoded = yield* pipe(
            yield* TestConsole.logLines,
            Effect.forEach((line) => Events.decodeLine(String(line)).pipe(Effect.option)),
          );

          expect(reporters.map((reporter) => reporter.name)).toEqual([
            "json",
            "markdown",
            "slack",
            "json",
          ]);
          expect(decoded.length).toBeGreaterThan(0);
          expect(decoded.filter(Option.isNone)).toEqual([]);
          expect([files.has("run.jsonl"), files.has("report.md")]).toEqual([true, true]);
        }).pipe(Effect.provide(History.layerMemory)),
      ),
  );

  it.effect("replaces the stdout reporters of the config with --format, tuples included", () =>
    Effect.gen(function* () {
      const names = yield* formattedAsJson([
        ["markdown", {}],
        ["json", {}],
        "terminal",
        ["markdown", { file: "report.md" }],
        ["html", { file: "report.html" }],
        "history",
      ]);

      expect(names).toEqual([
        ["markdown", "file"],
        ["html", "file"],
        ["history", "none"],
        ["json", "stdout"],
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("replaces the tuple stdout reporters of a loaded config with --format", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const folder = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(
        `${folder}/eval.config.mjs`,
        'export default { reporters: [["markdown", {}], ["json", {}], ["markdown", { file: "report.md" }]] };\n',
      );

      const config = yield* EvalConfig.load(folder);

      const reporters = config.pipe(
        Option.flatMap((loaded) => Option.fromNullishOr(loaded.reporters)),
        Option.getOrElse((): readonly EvalConfig.ReporterEntry[] => []),
      );

      expect(yield* formattedAsJson(reporters)).toEqual([
        ["markdown", "file"],
        ["json", "stdout"],
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a number of trials that is not positive", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(cli([...quiet, "--trials", "0"]));

      expect(JSON.stringify(failure)).toContain("positive number of trials");
      expect(yield* TestConsole.errorLines).toEqual([]);
    }).pipe(Effect.provide(services)),
  );
});
