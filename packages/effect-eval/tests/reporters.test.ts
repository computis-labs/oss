import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Deferred, Effect, FileSystem, Layer, Option, Path, pipe } from "effect";
import * as Dataset from "../src/dataset.ts";
import * as Eval from "../src/eval.ts";
import * as Events from "../src/events.ts";
import * as Git from "../src/git.ts";
import * as History from "../src/history.ts";
import * as Reporter from "../src/reporter.ts";
import * as Reporters from "../src/reporters.ts";
import type * as Run from "../src/run.ts";
import * as Runner from "../src/runner.ts";
import * as Scorer from "../src/scorer.ts";
import * as Variant from "../src/variant.ts";
import * as View from "../src/view.ts";

const categorizer = Eval.make({
  dataset: Dataset.fromIterable(["rent", "fuel", Dataset.skip("food", "no truth")], {
    id: (label: string) => label,
  }),
  name: "categorizer",
  score: Scorer.label<string, string>({ actual: Option.some, expected: Scorer.present }),
  task: (input) => Effect.succeed(input.input),
});

const collecting = () => {
  const lines: string[] = [];
  const write: Reporters.Write = (text) => Effect.sync(() => lines.push(text));

  return { lines, write };
};

const runWith = <E, R>(reporters: readonly Reporter.Reporter<E, R>[]) =>
  Runner.run(categorizer).pipe(Effect.provide(Reporter.layer(reporters)));

const withEnvironment = (env: Record<string, string>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

describe("Reporters.terminal", () => {
  it.effect("writes the plan, the end of each variant and the summary", () =>
    Effect.gen(function* () {
      const { lines, write } = collecting();

      const run = yield* runWith([Reporters.terminal({ color: false, width: 100, write })]);

      expect(lines[0]).toBe("categorizer: 2 cases, 1 skipped, 2 task calls");
      expect(lines[1]).toMatch(/^default: done in \d+\.\d s$/u);
      expect(lines[2]).toContain(`[ PASSED ]  categorizer · run ${run.id}`);
      expect(lines).toHaveLength(3);
    }),
  );

  it.effect("writes only the summary without progress", () =>
    Effect.gen(function* () {
      const { lines, write } = collecting();

      yield* runWith([Reporters.terminal({ color: false, progress: false, width: 100, write })]);

      expect(lines).toHaveLength(1);
    }),
  );
});

const CASES = 2000;
const LAST_CASE = `case-${String(CASES - 1)}`;

describe("Reporters.terminal with a slow writer", () => {
  it.effect(
    "draws the final summary from every case, even when progress events were dropped",
    () =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<boolean>();
        const lines: string[] = [];

        const write: Reporters.Write = (text) =>
          Deferred.await(gate).pipe(Effect.andThen(Effect.sync(() => lines.push(text))));

        const many = Eval.make({
          dataset: Dataset.fromIterable(
            Array.from({ length: CASES }, (_, index) => `case-${String(index)}`),
            { id: (id: string) => id },
          ),
          name: "many",
          score: Scorer.label<string, string>({
            actual: Option.some,
            expected: () => Scorer.present("right"),
          }),
          task: (input) =>
            (input.id === LAST_CASE ? Deferred.succeed(gate, true) : Effect.void).pipe(
              Effect.as(input.id === "case-1000" ? "wrong" : "right"),
            ),
        });

        const run = yield* Runner.run(many, { concurrency: 1 }).pipe(
          Effect.provide(
            Reporter.layer([
              Reporters.terminal({ color: false, progress: true, width: 120, write }),
            ]),
          ),
        );

        const summary = lines.at(-1) ?? "";

        expect(run.variants[0]?.summary.counts["wrong"]).toBe(1);
        expect(summary).toContain("To look at");
        expect(summary).toContain("case-1000");
      }),
    { timeout: 30_000 },
  );
});

describe("Reporters.markdown", () => {
  it.effect("writes the summary as Markdown", () =>
    Effect.gen(function* () {
      const { lines, write } = collecting();

      yield* runWith([Reporters.markdown({ write })]);

      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^\*\*✅ PASSED\*\* categorizer · run /u);
      expect(lines[0]).toContain("## Metrics");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const answering = (answer: string) =>
  Eval.make({
    dataset: Dataset.fromIterable(["rent"], { id: (label: string) => label }),
    name: "categorizer",
    score: Scorer.label<string, string>({ actual: Option.some, expected: Scorer.present }),
    task: () => Effect.succeed(answer),
  });

const onBranch = (branch: string) =>
  Git.layerStatic({ branch: Option.some(branch), dirty: false, sha: Option.none() });

describe("Reporters.markdown with single-variant baselines", () => {
  it.effect("takes each variant's change from the baseline run that has it", () =>
    Effect.gen(function* () {
      const saveOnMain = Layer.merge(Reporter.layer([History.reporter]), onBranch("main"));
      yield* Runner.run(answering("rent"), { variants: [Variant.make("a", Layer.empty)] }).pipe(
        Effect.provide(saveOnMain),
      );
      yield* Runner.run(answering("rent"), { variants: [Variant.make("b", Layer.empty)] }).pipe(
        Effect.provide(saveOnMain),
      );
      const { lines, write } = collecting();

      yield* Runner.run(answering("fuel"), {
        variants: [Variant.make("a", Layer.empty), Variant.make("b", Layer.empty)],
      }).pipe(
        Effect.provide(Layer.merge(Reporter.layer([Reporters.markdown({ write })]), onBranch("x"))),
      );

      const accuracyRows = lines
        .join("\n")
        .split("\n")
        .filter((line) => line.includes("| accuracy |"));

      expect(lines.join("\n")).not.toContain("stay out of it");
      expect(accuracyRows).toHaveLength(2);
      expect(accuracyRows.filter((row) => row.includes("-100.0 pt"))).toHaveLength(2);
    }).pipe(
      Effect.provide(History.layerMemory),
      Effect.provide(NodeServices.layer),
      withEnvironment({}),
    ),
  );
});

describe("Reporters.json", () => {
  it.effect("writes one decodable JSON line per event", () =>
    Effect.gen(function* () {
      const { lines, write } = collecting();

      yield* runWith([Reporters.json({ write })]);

      const decoded = yield* pipe(
        lines,
        Effect.forEach((line) => Events.decodeLine(line)),
      );

      expect(decoded.filter(Events.isCaseFinished).map((event) => event.case)).toEqual([
        "rent",
        "fuel",
      ]);
      expect(decoded.map((event) => event.sequence)).toEqual(decoded.map((_, index) => index));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const inTempFolder = <A, E, R>(use: (folder: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    return yield* use(yield* fs.makeTempDirectoryScoped());
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("Reporters writing files", () => {
  it.effect("writes the HTML dashboard to its path, creating the folder", () =>
    inTempFolder((folder) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join(folder, "reports", "eval.html");

        const run = yield* runWith([Reporters.html({ file })]);
        const html = yield* fs.readFileString(file);

        expect(html).toContain(`<title>categorizer · ${run.id}</title>`);
        expect(html).toContain('<label for="tabs-0-0">Summary</label>');
      }),
    ),
  );

  it.effect("keeps the Markdown run report and writes a comparison to its own file", () =>
    inTempFolder((folder) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const file = `${folder}/report.md`;

        const reporters = [
          Reporters.markdown({ file }),
          Reporters.markdown({ compareFile: `${folder}/diff.md`, file: `${folder}/other.md` }),
        ];

        const base = yield* runWith(reporters);
        const head = yield* runWith(reporters);
        yield* Reporter.compare(base, head).pipe(Effect.provide(Reporter.layer(reporters)));

        expect(yield* fs.readFileString(file)).toContain("## Metrics");
        expect(yield* fs.readFileString(`${folder}/report.compare.md`)).toContain("0 regressions");
        expect(yield* fs.readFileString(`${folder}/other.md`)).toContain("## Metrics");
        expect(yield* fs.readFileString(`${folder}/diff.md`)).toContain("0 regressions");
      }),
    ),
  );

  it.effect("writes the JSON lines to a file", () =>
    inTempFolder((folder) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const file = `${folder}/run.jsonl`;

        yield* runWith([Reporters.json({ file })]);
        const lines = (yield* fs.readFileString(file)).trimEnd().split("\n");

        const decoded = yield* pipe(
          lines,
          Effect.forEach((line) => Events.decodeLine(line)),
        );

        expect(decoded).toMatchObject([
          { _tag: "RunStarted" },
          { _tag: "CaseSkipped" },
          { _tag: "CaseStarted" },
          { _tag: "CaseFinished" },
          { _tag: "CaseStarted" },
          { _tag: "CaseFinished" },
          { _tag: "VariantFinished" },
          { _tag: "RunFinished" },
        ]);
      }),
    ),
  );
});

const secretRun = Eval.make({
  dataset: Dataset.fromIterable(["CUSTOMER_SECRET"], { id: () => "m1" }),
  name: "categorizer",
  score: Scorer.label<string, string>({ actual: Option.some, expected: Scorer.present }),
  sensitive: true,
  task: () => Effect.succeed("ACTUAL_SECRET"),
});

const historicalView = (_run: Run.Run, history: View.HistorySnapshot): View.View => [
  View.observationTable(
    [...Option.toArray(history.baseline), ...history.recent].flatMap((stored) =>
      stored.variants.flatMap((variant) => variant.observations),
    ),
  ),
];

describe("Reporters with a sensitive history", () => {
  it.effect("redact the sensitive runs of the history before a View sees them", () =>
    Effect.gen(function* () {
      yield* Runner.run(secretRun).pipe(Effect.provide(Reporter.layer([Reporters.history])));
      const markdown = collecting();
      const terminal = collecting();
      const custom: string[] = [];
      const fs = yield* FileSystem.FileSystem;
      const htmlFile = `${yield* fs.makeTempDirectoryScoped()}/report.html`;

      yield* runWith([
        Reporters.markdown({ view: historicalView, write: markdown.write }),
        { ...Reporters.html({ file: htmlFile, view: historicalView }), acceptsSensitive: false },
        {
          ...Reporters.terminal({
            color: false,
            progress: false,
            view: historicalView,
            width: 120,
            write: terminal.write,
          }),
          acceptsSensitive: false,
        },
        Reporter.make({
          name: "custom",
          onRunFinished: (run) =>
            History.snapshot(run).pipe(
              Effect.flatMap((history) =>
                Effect.sync(() => {
                  custom.push(
                    JSON.stringify(historicalView(run, history)),
                    JSON.stringify(
                      Option.toArray(history.baseline).map((stored) => stored.outputs),
                    ),
                  );
                }),
              ),
            ),
        }),
      ]);

      const printed = [
        ...markdown.lines,
        ...terminal.lines,
        ...custom,
        yield* fs.readFileString(htmlFile),
      ].join("\n");

      expect(printed).toContain("[redacted]");
      expect(printed).not.toContain("SECRET");
    }).pipe(
      Effect.scoped,
      Effect.provide(History.layerMemory),
      Effect.provide(
        Git.layerStatic({ branch: Option.some("main"), dirty: false, sha: Option.none() }),
      ),
      Effect.provide(NodeServices.layer),
    ),
  );
});

describe("Reporters.history", () => {
  it.effect("stores the run in the history", () =>
    Effect.gen(function* () {
      const run = yield* runWith([Reporters.history]);

      expect((yield* History.load("categorizer", History.latest)).id).toBe(run.id);
    }).pipe(Effect.provide(History.layerMemory)),
  );
});

describe("Reporters.colorSupported and isCi", () => {
  it.effect("turns color off when NO_COLOR is set", () =>
    Effect.gen(function* () {
      expect(yield* Reporters.colorSupported).toBe(false);
    }).pipe(
      Effect.provide(
        Layer.merge(
          NodeServices.layer,
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { NO_COLOR: "1" } })),
        ),
      ),
    ),
  );

  it.effect("knows when it runs on CI", () =>
    Effect.gen(function* () {
      const onCi = yield* Reporters.isCi.pipe(withEnvironment({ CI: "true" }));
      const local = yield* Reporters.isCi.pipe(withEnvironment({}));

      expect([onCi, local]).toEqual([true, false]);
    }),
  );
});

describe("Reporters.terminalWidth", () => {
  it.effect("falls back to 100 columns without a terminal", () =>
    Effect.gen(function* () {
      expect(yield* Reporters.terminalWidth).toBe(100);
    }),
  );
});
