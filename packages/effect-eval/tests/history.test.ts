import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, FileSystem, Layer, Option, Path } from "effect";
import * as Dataset from "../src/dataset.ts";
import * as Eval from "../src/eval.ts";
import * as Git from "../src/git.ts";
import * as History from "../src/history.ts";
import * as Reporter from "../src/reporter.ts";
import * as Runner from "../src/runner.ts";
import * as Scorer from "../src/scorer.ts";

const categorizer = (answer: string) =>
  Eval.make({
    dataset: Dataset.fromIterable(["m1", "m2"], { id: (id: string) => id }),
    name: "categorizer",
    score: Scorer.label<string, string>({
      actual: Option.some,
      expected: () => Scorer.present("rent"),
    }),
    task: () => Effect.succeed(answer),
  });

const onBranch = (branch: string) =>
  Git.layerStatic({ branch: Option.some(branch), dirty: false, sha: Option.some(`${branch}-sha`) });

const saved = (answer: string, branch: string) =>
  Runner.run(categorizer(answer)).pipe(
    Effect.provide(Layer.merge(Reporter.layer([History.reporter]), onBranch(branch))),
  );

describe("History.parseSelector", () => {
  it("reads latest, baseline, a JSONL file and a run id", () => {
    expect([
      History.parseSelector("latest"),
      History.parseSelector("baseline", "develop"),
      History.parseSelector("runs/ci.jsonl"),
      History.parseSelector("lx3k9"),
    ]).toEqual([
      History.latest,
      History.baseline("develop"),
      History.fromFile("runs/ci.jsonl"),
      History.id("lx3k9"),
    ]);
  });
});

describe("History.layerMemory", () => {
  it.effect("lists the stored runs of an eval newest first", () =>
    Effect.gen(function* () {
      const first = yield* saved("rent", "main");
      const second = yield* saved("fuel", "feature/x");

      const entries = yield* History.list("categorizer");

      expect(entries.map((entry) => entry.id)).toEqual([second.id, first.id]);
      expect(entries[0]).toMatchObject({ branch: Option.some("feature/x"), passed: true });
      expect(yield* History.list("another eval")).toEqual([]);
    }).pipe(Effect.provide(History.layerMemory)),
  );

  it.effect("loads a run by id, as the latest, on a branch and as the baseline", () =>
    Effect.gen(function* () {
      const onMain = yield* saved("rent", "main");
      const onFeature = yield* saved("fuel", "feature/x");

      const byId = yield* History.load("categorizer", History.id(onMain.id));
      const latest = yield* History.load("categorizer", History.latest);
      const feature = yield* History.load("categorizer", History.onBranch("feature/x"));
      const baseline = yield* History.load("categorizer", History.baseline("main"));

      expect([byId.id, latest.id, feature.id, baseline.id]).toEqual([
        onMain.id,
        onFeature.id,
        onFeature.id,
        onMain.id,
      ]);
      expect(baseline.variants[0]?.summary.counts["right"]).toBe(2);
    }).pipe(Effect.provide(History.layerMemory)),
  );

  it.effect("never picks a rescore as the baseline", () =>
    Effect.gen(function* () {
      const original = yield* saved("rent", "main");
      yield* Runner.rescore(categorizer("rent"), { from: History.latest }).pipe(
        Effect.provide(Layer.merge(Reporter.layer([History.reporter]), onBranch("main"))),
      );

      const baseline = yield* History.load("categorizer", History.baseline("main"));

      expect(baseline.id).toBe(original.id);
    }).pipe(Effect.provide(History.layerMemory)),
  );

  it.effect("fails when no run matches the selector", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(History.load("categorizer", History.baseline("main")));

      expect(failure.message).toBe("No run of categorizer matches the baseline on main.");
    }).pipe(Effect.provide(History.layerMemory)),
  );

  it.effect(
    "takes a snapshot with the baseline and the recent runs other than the current one",
    () =>
      Effect.gen(function* () {
        const onMain = yield* saved("rent", "main");
        const onFeature = yield* saved("fuel", "feature/x");
        const current = yield* saved("rent", "feature/x");

        const snapshot = yield* History.snapshot(current, { baseBranch: "main" });

        expect(snapshot.baseline.pipe(Option.map((run) => run.id))).toEqual(Option.some(onMain.id));
        expect(snapshot.recent.map((run) => run.id)).toEqual([onFeature.id, onMain.id]);
      }).pipe(Effect.provide(History.layerMemory)),
  );
});

describe("History.snapshot", () => {
  it.effect("is empty without a history", () =>
    Effect.gen(function* () {
      const run = yield* Runner.run(categorizer("rent"));

      expect(yield* History.snapshot(run)).toEqual({ baseline: Option.none(), recent: [] });
    }),
  );
});

const inTempRoot = <A, E, R>(use: (root: string) => Effect.Effect<A, E, R | History.History>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();

    return yield* use(root).pipe(Effect.provide(History.layerFileSystem(root)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("History.layerFileSystem", () => {
  it.effect("writes each run as JSONL with an index and reads it back", () =>
    inTempRoot((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stored = yield* saved("rent", "main");

        const files = yield* fs.readDirectory(path.join(root, "categorizer"));
        const loaded = yield* History.load("categorizer", History.latest);

        expect(files.toSorted()).toEqual([`${stored.id}.jsonl`, "index.jsonl"]);
        expect(loaded.id).toBe(stored.id);
        expect(loaded.variants[0]?.summary).toEqual(stored.variants[0]?.summary);
      }),
    ),
  );

  it.effect("appends to the index on every run", () =>
    inTempRoot(() =>
      Effect.gen(function* () {
        const first = yield* saved("rent", "main");
        const second = yield* saved("fuel", "main");

        const entries = yield* History.list("categorizer");

        expect(entries.map((entry) => entry.id).toSorted()).toEqual(
          [first.id, second.id].toSorted(),
        );
      }),
    ),
  );

  it.effect("loads a run from a JSONL file by path", () =>
    inTempRoot((root) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const stored = yield* saved("rent", "main");

        const loaded = yield* History.load(
          "categorizer",
          History.fromFile(path.join(root, "categorizer", `${stored.id}.jsonl`)),
        );

        expect(loaded.id).toBe(stored.id);
      }),
    ),
  );

  it.effect("has an empty index before the first run", () =>
    inTempRoot(() =>
      Effect.gen(function* () {
        expect(yield* History.list("categorizer")).toEqual([]);
      }),
    ),
  );

  it.effect("fails on a file whose events do not decode", () =>
    inTempRoot((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join(root, "broken.jsonl");
        yield* fs.writeFileString(file, '{"_tag":"RunStarted","version":99}\n');

        const failure = yield* Effect.flip(History.load("categorizer", History.fromFile(file)));

        expect(failure.message).toBe(
          `${file} has an event that does not decode: a run of another events version?`,
        );
      }),
    ),
  );
});

const savedWithId = (id: string) =>
  Effect.service(History.History).pipe(
    Effect.flatMap((history) =>
      history.save([
        {
          _tag: "RunStarted",
          at: DateTime.makeUnsafe(0),
          datasetHash: "",
          eval: "categorizer",
          git: { branch: Option.none(), dirty: false, sha: Option.none() },
          plan: { cases: 0, invocations: 0, skipped: 0 },
          rescoreOf: Option.none(),
          runId: id,
          sensitive: false,
          sequence: 0,
          trials: 1,
          variants: [],
          version: 1,
        },
      ]),
    ),
  );

describe("History.load by id", () => {
  it.effect("prefers an exact id, accepts a unique prefix and refuses an ambiguous one", () =>
    Effect.gen(function* () {
      yield* savedWithId("abc");
      yield* savedWithId("abcdef");
      yield* savedWithId("abcxyz");
      yield* savedWithId("zzz123");

      const exact = yield* History.load("categorizer", History.id("abc"));
      const prefix = yield* History.load("categorizer", History.id("zzz"));
      const ambiguous = yield* Effect.flip(History.load("categorizer", History.id("ab")));

      expect([exact.id, prefix.id]).toEqual(["abc", "zzz123"]);
      expect(ambiguous.message).toBe(
        "The id ab matches 3 runs of categorizer: abc, abcdef, abcxyz.",
      );
    }).pipe(Effect.provide(History.layerMemory)),
  );
});

describe("History.layerFileSystem index", () => {
  const files = new Map<string, string>();

  const racy = FileSystem.layerNoop({
    exists: (path) => Effect.sync(() => files.has(path)),
    makeDirectory: () => Effect.void,
    readFileString: (path) => Effect.sync(() => files.get(path) ?? ""),
    writeFileString: (path, data, options) =>
      Effect.gen(function* () {
        const before = options?.flag === "a" ? (files.get(path) ?? "") : "";
        yield* Effect.yieldNow;
        files.set(path, `${before}${data}`);
      }),
  });

  it.effect("keeps every index line when runs are saved at the same time", () =>
    Effect.gen(function* () {
      const runs = yield* Effect.all(
        ["rent", "fuel", "rent", "fuel"].map((answer) => saved(answer, "main")),
        { concurrency: "unbounded" },
      );

      const entries = yield* History.list("categorizer");

      expect(entries.map((entry) => entry.id).toSorted()).toEqual(
        runs.map((run) => run.id).toSorted(),
      );
    }).pipe(
      Effect.provide(History.layerFileSystem("/history")),
      Effect.provide(Layer.merge(racy, Path.layer)),
    ),
  );
});
