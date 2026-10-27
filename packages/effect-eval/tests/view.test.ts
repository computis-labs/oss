import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Result } from "effect";
import * as Agreement from "../src/agreement.ts";
import * as Charts from "../src/chart.ts";
import * as Dataset from "../src/dataset.ts";
import * as Eval from "../src/eval.ts";
import * as Gate from "../src/gate.ts";
import * as History from "../src/history.ts";
import * as Reporter from "../src/reporter.ts";
import * as Metric from "../src/metric.ts";
import * as Observation from "../src/observation.ts";
import type * as Run from "../src/run.ts";
import * as Runner from "../src/runner.ts";
import * as Scorer from "../src/scorer.ts";
import * as Theme from "../src/theme.ts";
import * as Usage from "../src/usage.ts";
import * as View from "../src/view.ts";
import type { Block, TableData } from "../src/view.ts";
import * as ViewHtml from "../src/view-html.ts";
import * as ViewMarkdown from "../src/view-markdown.ts";
import * as ViewText from "../src/view-text.ts";
import { runOf, sampleRuns, scoredAs } from "./fixtures.ts";

const everyBlock = (blocks: readonly Block[]): readonly Block[] =>
  blocks.flatMap((block) => [
    block,
    ...everyBlock(
      View.$match(block, {
        Badge: () => [],
        Figure: () => [],
        Row: ({ children }) => children,
        Section: ({ children }) => children,
        Table: () => [],
        Tabs: ({ tabs }) => tabs.flatMap((tab) => tab.children),
        Text: () => [],
      }),
    ),
  ]);

const sectionTitles = (blocks: readonly Block[]) =>
  everyBlock(blocks).flatMap((block) => (View.$is("Section")(block) ? [block.title] : []));

const texts = (blocks: readonly Block[]) =>
  everyBlock(blocks).flatMap((block) => (View.$is("Text")(block) ? [block.text] : []));

const tableWith = (blocks: readonly Block[], column: string) =>
  everyBlock(blocks)
    .filter(View.$is("Table"))
    .find((data: TableData) => data.columns.includes(column));

describe("View.summary", () => {
  it.effect("opens with the outcome and the eval, run, branch and short sha", () =>
    Effect.gen(function* () {
      const { head } = yield* sampleRuns;

      const view = View.summary(head);
      const badges = everyBlock(view).filter(View.$is("Badge"));

      expect(badges.map((badge) => [badge.label, badge.tone])).toEqual([
        ["failed", Theme.tones.bad],
      ]);
      expect(texts(view)[0]).toBe(
        `categorizer · run ${head.id} · feature/categorizer @ 0123456 (dirty)`,
      );
    }),
  );

  it.effect(
    "has the metrics, cases, groups, variants, trials, gates, to look at and skipped sections",
    () =>
      Effect.gen(function* () {
        const { head } = yield* sampleRuns;

        expect(sectionTitles(View.summary(head))).toEqual([
          "Metrics",
          "Cases",
          "Groups",
          "Variants",
          "Trials",
          "Gates",
          "Gate violations",
          "small · accuracy ≥ 0.7",
          "To look at",
          "Skipped",
        ]);
      }),
  );

  it.effect("states calls, tokens and cost of each variant", () =>
    Effect.gen(function* () {
      const { head } = yield* sampleRuns;

      expect(texts(View.summary(head))[1]).toMatch(
        /^small: 8 calls, 1024 tokens, \$0\.016, \d+\.\d s · large: 8 calls, 1024 tokens, \$0\.016, \d+\.\d s$/u,
      );
    }),
  );

  it.effect("shows the change from the baseline with a tone", () =>
    Effect.gen(function* () {
      const { head, history } = yield* sampleRuns;

      const metrics = tableWith(View.summary(head, history), "Δ baseline (paired)");

      const accuracy = metrics?.rows.find(
        (row) => row[0]?.text === "small" && row[1]?.text === "accuracy",
      );

      expect(accuracy?.[4]).toEqual({ text: "-25.0 pt", tone: Theme.tones.bad });
    }),
  );

  it("takes the change from the baseline over the paired observations only", () => {
    const baseline = runOf("base", [
      scoredAs({ case: "a", right: true }),
      scoredAs({ case: "b", right: false }),
    ]);

    const removed = runOf("head", [scoredAs({ case: "a", right: true })]);

    const added = runOf("head", [
      scoredAs({ case: "a", right: true }),
      scoredAs({ case: "c", right: false }),
    ]);

    const accuracyChange = (head: Run.Run, base: Run.Run) =>
      tableWith(
        View.summary(head, { baseline: Option.some(base), recent: [base] }),
        "Δ baseline (paired)",
      )?.rows.find((row) => row[1]?.text === "accuracy")?.[4]?.text;

    expect([
      accuracyChange(removed, baseline),
      accuracyChange(added, runOf("base", [scoredAs({ case: "a", right: true })])),
    ]).toEqual(["0.0 pt", "0.0 pt"]);
    expect(
      texts(View.summary(removed, { baseline: Option.some(baseline), recent: [baseline] })),
    ).toContain(
      "Δ baseline uses only the observations both runs have: 0 added and 1 removed stay out of it.",
    );
    expect(
      texts(
        View.summary(
          runOf("head", [
            scoredAs({ case: "reasoning=b · case", key: "", right: true, variant: "model=a" }),
          ]),
          {
            baseline: Option.some(
              runOf("base", [
                scoredAs({ case: "case", key: "", right: true, variant: "model=a · reasoning=b" }),
              ]),
            ),
            recent: [],
          },
        ),
      ),
    ).toContain(
      "Δ baseline uses only the observations both runs have: 1 added and 1 removed stay out of it.",
    );
  });

  it.effect("shows no change without a baseline", () =>
    Effect.gen(function* () {
      const { head } = yield* sampleRuns;

      const metrics = tableWith(View.summary(head), "Δ baseline (paired)");

      expect(new Set(metrics?.rows.map((row) => row[4]?.text))).toEqual(new Set(["—"]));
    }),
  );

  it.effect("lists the wrong observations to look at with expected and actual", () =>
    Effect.gen(function* () {
      const { head } = yield* sampleRuns;

      const toLookAt = tableWith(View.summary(head), "verdict");

      expect(toLookAt?.rows.map((row) => row.map((entry) => entry.text))).toEqual([
        ["small", "m1", "", "wrong", "rent", "fuel"],
        ["small", "m2", "", "wrong", "rent", "fuel"],
        ["small", "m1", "", "wrong", "rent", "fuel"],
        ["small", "m2", "", "wrong", "rent", "fuel"],
      ]);
    }),
  );

  it("also lists unclassified exclusions and closed gaps, and shows the notes", () => {
    const right = scoredAs({ case: "m1", right: true });

    const run = runOf("run-a", [
      {
        ...right,
        observation: Observation.knownGap("no reference")(right.observation),
      },
      {
        ...scoredAs({ case: "m2", right: true }),
        observation: Observation.exclude(Scorer.unclassified)(
          Observation.compared({
            agreement: Agreement.different,
            detail: { actual: "x", expected: "y", note: "Body/Causale" },
            key: "m2",
          }),
        ),
      },
      {
        ...scoredAs({ case: "m3", right: true }),
        observation: Observation.exclude("convention")(scoredAs({ right: false }).observation),
      },
    ]);

    const toLookAt = tableWith(View.summary(run), "verdict");

    expect(toLookAt?.columns).toContain("note");
    expect(toLookAt?.rows.map((row) => row.map((entry) => entry.text))).toEqual([
      ["default", "m2", "m2", "excluded(unclassified)", "y", "x", "Body/Causale"],
      ["default", "m1", "m1", "right (gap closed)", "", "", ""],
    ]);
  });

  it.effect("prioritizes unclassified paths and gate violations over unrelated failures", () =>
    Effect.gen(function* () {
      const run = yield* Runner.run(
        Eval.make({
          dataset: Dataset.fromIterable(
            [
              ...Array.from({ length: 45 }, (_, index) => `failed-${String(index)}`),
              "unclassified-path",
              "gated-path",
            ],
            { id: (id: string) => id },
          ),
          gates: [
            Gate.max(Metric.excluded(Scorer.unclassified), 0),
            Gate.by("critical", Gate.max(Metric.wrong, 0)),
          ],
          name: "crowded",
          score: Scorer.make((input: Dataset.Case<string>) =>
            Effect.succeed([
              input.id === "unclassified-path"
                ? Observation.exclude(Scorer.unclassified)(
                    scoredAs({ key: input.id, right: false }).observation,
                  )
                : Observation.tagged(...(input.id === "gated-path" ? ["critical"] : []))(
                    scoredAs({ key: input.id, right: false }).observation,
                  ),
            ]),
          ),
          task: (input) => Effect.succeed(input.id),
        }),
      );

      const view = View.summary(run);

      const review = view
        .filter(View.$is("Section"))
        .find((section) => section.title === "To look at");

      const violations = view
        .filter(View.$is("Section"))
        .find((section) => section.title === "Gate violations");

      expect(
        tableWith(review?.children ?? [], "key")
          ?.rows.slice(0, 2)
          .map((row) => row[2]?.text),
      ).toEqual(["unclassified-path", "gated-path"]);
      expect(texts(review?.children ?? [])).toContain(
        "+7 more; see the JSON reporter or history for all observations.",
      );
      expect(tableWith(violations?.children ?? [], "key")?.rows[0]?.[2]?.text).toBe(
        "unclassified-path",
      );
      expect(
        everyBlock(violations?.children ?? [])
          .filter(View.$is("Table"))
          .flatMap((table) => table.rows.map((row) => row[2]?.text)),
      ).toEqual(["unclassified-path", "gated-path"]);
    }),
  );

  it.effect(
    "caps each failed gate separately and keeps all violations in the run and history",
    () =>
      Effect.gen(function* () {
        const run = yield* Runner.run(
          Eval.make({
            dataset: Dataset.fromIterable(
              Array.from({ length: 48 }, (_, index) => `path-${String(index)}`),
              { id: (id: string) => id },
            ),
            gates: [Gate.max(Metric.wrong, 0)],
            name: "many-violations",
            score: Scorer.label<string, string>({ actual: Option.some, expected: Scorer.present }),
            task: () => Effect.succeed("wrong"),
          }),
        ).pipe(Effect.provide(Reporter.layer([History.reporter])));

        const stored = yield* History.load("many-violations", History.latest);
        expect(stored.gates[0]?.violations).toHaveLength(48);
        const view = View.summary(run);

        const violations = view
          .filter(View.$is("Section"))
          .find((section) => section.title === "Gate violations");

        expect(run.gates[0]?.violations).toHaveLength(48);
        expect(tableWith(violations?.children ?? [], "key")?.rows).toHaveLength(20);
        expect(texts(violations?.children ?? [])).toContain(
          "+28 more; see the JSON reporter or history for all gate violations.",
        );
      }).pipe(Effect.provide(History.layerMemory)),
  );

  it("counts every exclusion reason, including custom reasons, per variant", () => {
    const excluded = [
      "convention",
      "pending",
      "pending",
      "extra",
      "skipped",
      "unclassified",
      "legal form",
    ];

    const observations = excluded.map((reason, index) => ({
      ...scoredAs({ case: `p-${String(index)}`, right: false }),
      observation: Observation.exclude(reason)(scoredAs({ right: false }).observation),
    }));

    const view = View.summary(runOf("excluded", observations));
    expect(tableWith(view, "reason")?.rows.map((row) => row.map((entry) => entry.text))).toEqual([
      ["default", "convention", "1"],
      ["default", "extra", "1"],
      ["default", "legal form", "1"],
      ["default", "pending", "2"],
      ["default", "skipped", "1"],
      ["default", "unclassified", "1"],
    ]);
    expect(
      sectionTitles(View.summary(runOf("no-exclusions", [scoredAs({ right: true })]))),
    ).not.toContain("Exclusions");
  });

  it("lists the outputs it could not store, with the reason", () => {
    const base = runOf("run-a", [scoredAs({ case: "m1", right: true })]);

    const run: Run.Run = {
      ...base,
      outputs: [
        {
          case: "m1",
          failure: Option.none(),
          inputHash: "h",
          judgements: [],
          output: Option.none(),
          outputError: Option.some("unencodable: Expected a value with a length of at least 3"),
          trial: 1,
          variant: "default",
        },
      ],
    };

    const notStored = tableWith(View.summary(run), "reason");

    expect(notStored?.rows.map((row) => row.map((entry) => entry.text))).toEqual([
      ["default", "m1", "unencodable: Expected a value with a length of at least 3"],
    ]);
  });

  it("says the cost is unknown when a call has no price", () => {
    const base = runOf("run-a", [scoredAs({ case: "m1", right: true })]);

    const run: Run.Run = {
      ...base,
      variants: base.variants.map((variant) => ({
        ...variant,
        usage: Usage.total([Usage.fromRecorded({ costUsd: 0.2 }), Usage.fromRecorded({})]),
      })),
    };

    expect(texts(View.summary(run)).join("\n")).toContain("2 calls, 0 tokens, cost unknown");
  });
});

describe("View.summary groups and case outcomes", () => {
  it.effect("shows the accuracy of each group and how many cases succeeded or failed", () =>
    Effect.gen(function* () {
      const run = yield* Runner.run(
        Eval.make({
          dataset: Dataset.fromIterable(["p1", "p2", "p3"], { id: (page: string) => page }),
          name: "golden-set",
          score: Scorer.make((input: Dataset.Case<string>, outcome: Scorer.Outcome<string>) =>
            Effect.succeed(
              Result.match(outcome, {
                onFailure: () => [],
                onSuccess: () =>
                  (input.id === "p1" ? ["fiscal", "fiscal", "supplier"] : ["supplier"]).map(
                    (group, index) =>
                      Observation.compared({
                        agreement:
                          input.id === "p1" && index === 0 ? Agreement.different : Agreement.exact,
                        detail: { actual: "", expected: "" },
                        key: `${group}-${String(index)}`,
                        tags: [`group:${group}`],
                      }),
                  ),
              }),
            ),
          ),
          task: (input) =>
            input.id === "p2" ? Effect.fail("generation failed") : Effect.succeed(input.id),
          trials: 2,
        }),
      );

      const summary = View.summary(run);

      expect(sectionTitles(summary)).toEqual(expect.arrayContaining(["Groups", "Cases"]));
      expect(
        tableWith(summary, "succeeded")?.rows.map((row) => row.map((entry) => entry.text)),
      ).toEqual([
        ["default", "1", "2", "1"],
        ["default", "2", "2", "1"],
      ]);
      expect(
        tableWith(summary, "group")?.rows.map((row) => [row[1]?.text, row[2]?.text.split(" ")[0]]),
      ).toEqual([
        ["fiscal", "0.500"],
        ["supplier", "1.000"],
      ]);
    }),
  );
});

describe("View.summary trials", () => {
  const flipping = runOf(
    "run-a",
    [
      scoredAs({ case: "m1", right: true, trial: 1 }),
      scoredAs({ case: "m1", right: false, trial: 2 }),
      scoredAs({ case: "m2", right: true, trial: 1 }),
      scoredAs({ case: "m2", right: true, trial: 2 }),
    ],
    2,
  );

  it("adds the mean and deviation per trial, pass@k, pass^k and the unstable observations", () => {
    const summary = View.summary(flipping);

    expect(sectionTitles(summary)).toContain("Trials");
    expect(
      tableWith(summary, "sd")
        ?.rows.find((row) => row[1]?.text === "accuracy")
        ?.map((entry) => entry.text),
    ).toEqual(["default", "accuracy", "0.750", "0.354"]);
    expect(
      tableWith(summary, "sd")
        ?.rows.find((row) => row[1]?.text === "wrong")
        ?.map((entry) => entry.text),
    ).toEqual(["default", "wrong", "0.500", "0.707"]);
    expect(texts(summary)).toContain("default: pass@2 1.000, pass^2 0.500");
    expect(
      tableWith(summary, "verdicts")?.rows.map((row) => row.map((entry) => entry.text)),
    ).toEqual([["default", "m1", "m1", "right, wrong"]]);
  });

  it("says why pass@k is unavailable, or what it left out, when an observation has fewer than k trials", () => {
    const short = View.summary(
      runOf("run-a", [scoredAs({ case: "m1", right: true, trial: 1 })], 2),
    );

    const partial = View.summary(
      runOf(
        "run-a",
        [
          scoredAs({ case: "m1", right: true, trial: 1 }),
          scoredAs({ case: "m2", right: true, trial: 1 }),
          scoredAs({ case: "m2", right: true, trial: 2 }),
        ],
        2,
      ),
    );

    expect(texts(short)).toContain(
      "default: pass@2 and pass^2 unavailable: no observation was measured in all 2 trials",
    );
    expect(texts(partial)).toContain(
      "default: pass@2 1.000, pass^2 1.000, leaving out 1 observations measured in fewer than 2 trials",
    );
  });

  it("has no trial section with a single trial", () => {
    expect(sectionTitles(View.summary(runOf("run-a", [scoredAs({ right: true })])))).not.toContain(
      "Trials",
    );
  });

  it.effect("shows the trials in the terminal, Markdown and HTML output", () =>
    Effect.gen(function* () {
      const text = yield* ViewText.render(View.summary(flipping), { color: false, width: 100 });
      const markdown = yield* ViewMarkdown.render(View.summary(flipping));
      const html = yield* ViewHtml.render(View.dashboard(flipping), { title: "run-a" });

      expect([text, markdown, html].map((output) => output.includes("pass@2 1.000"))).toEqual([
        true,
        true,
        true,
      ]);
    }),
  );
});

describe("View.compare", () => {
  it.effect("counts regressions and fixes per variant and lists them", () =>
    Effect.gen(function* () {
      const { base, head } = yield* sampleRuns;

      const view = View.compare(base, head);

      expect(texts(view).slice(1)).toEqual([
        `compared with run ${base.id}`,
        "4 regressions, 2 fixes · McNemar p = 0.688",
        "0 regressions, 0 fixes · McNemar p = 1.000",
      ]);
      expect(sectionTitles(view)).toEqual(["small", "Regressions", "Fixes", "large"]);
    }),
  );

  it("says how many observations the baseline did not have or lost", () => {
    const view = View.compare(
      runOf("base", [scoredAs({ case: "gone", right: true })]),
      runOf("head", [scoredAs({ case: "new", right: true })]),
    );

    expect(texts(view)).toContain(
      "1 observations added, 1 removed since the baseline; the deltas use only the observations both runs have",
    );
  });

  it("lists the added and removed observations", () => {
    const view = View.compare(
      runOf("base", [scoredAs({ case: "removed-page.pdf", key: "", right: true })]),
      runOf("head", [scoredAs({ case: "added-page.pdf", key: "", right: false })]),
    );

    expect(sectionTitles(view)).toEqual(["Added", "Removed", "default"]);
    expect(tableWith(view, "observation")?.rows.map((row) => row.map((cell) => cell.text))).toEqual(
      [["default · added-page.pdf · trial 1", "wrong"]],
    );
    expect(
      everyBlock(view)
        .filter(View.$is("Table"))
        .map((table) => table.rows.map((row) => row[0]?.text)),
    ).toEqual([["default · added-page.pdf · trial 1"], ["default · removed-page.pdf · trial 1"]]);
  });

  it("lists at most twenty added observations and says how many more there are", () => {
    const view = View.compare(
      runOf("base", []),
      runOf(
        "head",
        Array.from({ length: 23 }, (_, index) =>
          scoredAs({ case: `page-${String(index).padStart(2, "0")}`, right: true }),
        ),
      ),
    );

    expect(tableWith(view, "observation")?.rows).toHaveLength(20);
    expect(texts(view)).toContain("+3 more");
  });
});

describe("View.dashboard", () => {
  it.effect("puts the summary, trend, unstable cases, cost and groups in tabs", () =>
    Effect.gen(function* () {
      const { head, history } = yield* sampleRuns;

      const [tabs] = View.dashboard(head, history);

      expect(
        tabs !== undefined && View.$is("Tabs")(tabs) ? tabs.tabs.map((tab) => tab.title) : [],
      ).toEqual(["Summary", "Trend", "Unstable cases", "Cost", "Groups"]);
    }),
  );

  it.effect("gives the accuracy of every group of every variant", () =>
    Effect.gen(function* () {
      const { head } = yield* sampleRuns;

      const groups = tableWith(View.dashboard(head), "group");

      expect(groups?.rows.map((row) => [row[0]?.text, row[1]?.text])).toEqual([
        ["small", "rent"],
        ["small", "fuel"],
        ["large", "rent"],
        ["large", "fuel"],
      ]);
    }),
  );
});

describe("View.chartTable", () => {
  it("gives a figure a table to fall back on", () => {
    const chart = Charts.Variants({
      bars: [{ high: Option.some(0.9), low: Option.some(0.6), value: 0.8, variant: "small" }],
      metric: "accuracy",
      title: "accuracy by variant",
    });

    expect(View.chartTable(chart).rows.map((row) => row.map((entry) => entry.text))).toEqual([
      ["small", "0.800", "0.600", "0.900"],
    ]);
  });
});

describe("View.firstOf", () => {
  it.effect("uses the first renderer that draws the charts in a kind the target accepts", () =>
    Effect.gen(function* () {
      const drawn = yield* View.firstOf(
        View.unsupported,
        () => Effect.succeed(Option.some(View.drawing(View.drawingKinds.html, "<svg>"))),
        () => Effect.succeed(Option.some(View.drawing(View.drawingKinds.text, "drawn"))),
        () => Effect.succeed(Option.some(View.drawing(View.drawingKinds.text, "never"))),
      )([], { accepts: [View.drawingKinds.text], theme: Theme.computis, width: 80 });

      expect(drawn).toEqual(Option.some(View.drawing(View.drawingKinds.text, "drawn")));
    }),
  );
});

describe("View.outcomeLabel and View.signed", () => {
  it("name the outcome of a run and sign a change in points", () => {
    expect([
      View.outcomeLabel({ interrupted: true, passed: true }),
      View.outcomeLabel({ interrupted: false, passed: true }),
      View.outcomeLabel({ interrupted: false, passed: false }),
    ]).toEqual(["interrupted", "passed", "failed"]);
    expect([View.signed(0.125), View.signed(-0.05), View.signed(0)]).toEqual([
      "+12.5 pt",
      "-5.0 pt",
      "0.0 pt",
    ]);
  });
});
