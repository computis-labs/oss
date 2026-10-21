# @computis/effect-eval

Evals for LLM features, written with Effect.

- You declare an eval: a dataset, a task that calls your feature, a scorer that compares the output with the expected answer, and gates that decide whether the run passes.
- The scorer emits observations. Each observation gets a verdict (`right`, `partial`, `wrong`, `missed`, `gap`, `unscored`, `errored`, `excluded`), and the metrics come from those verdicts: answered, precision, recall, accuracy and mean agreement, each with a confidence interval.
- One eval runs many variants (a model, a prompt, a reasoning setting) and many trials, and reports pass@k, pass^k and the cases whose verdict flips between trials.
- A run is a stream of events. Reporters turn it into terminal output, Markdown, an HTML dashboard, JSON lines or a history on disk. From the history you can compare two runs, fail on regressions, and score stored outputs again without calling the model.
- Failures of the task never stop the run. They become `errored` observations.

## Install

```sh
npm install @computis/effect-eval effect
```

It needs Effect 4 and is ESM only. The core modules depend on no platform package: the services they need, such as `FileSystem`, come from the layer you provide (`@effect/platform-node`, `@effect/platform-bun` or another).

The root entrypoint exports every core module as a namespace: `import { Dataset, Eval, Gate } from "@computis/effect-eval"`. The `config` and `cli` modules are `EvalConfig` and `EvalCli`, so they do not clash with `Config` from `effect`. Each module also has its own subpath, such as `@computis/effect-eval/dataset`.

Some entrypoints need an optional peer dependency, so the root entrypoint leaves them out. Install the peer only if you import that entrypoint.

| Entrypoint                            | Peer dependency                                          |
| ------------------------------------- | -------------------------------------------------------- |
| `@computis/effect-eval/vitest`        | `vitest`, `@effect/vitest`                               |
| `@computis/effect-eval/chart-vega`    | `vega`, `vega-lite`, `@resvg/resvg-js`, `terminal-image` |
| `@computis/effect-eval/chart-unicode` | `simple-ascii-chart`                                     |

`chart-html` and `chart-mermaid` need nothing: the HTML renderer loads Vega from a CDN in the page.

## The model in one paragraph

A dataset yields `Case`s: an id, the input and tags such as `group:pricing`. The task runs on a case (or on a batch of cases) and returns an output. The scorer turns the case and the outcome into `Observation`s. An observation records whether a value was expected (`present`, `absent`, `unknown`), whether one came back (`present`, `absent`), how well they agree (`Exact`, `Partial(score)`, `Different`), and optionally a failure, a known gap or an exclusion. `Verdict.of` derives the verdict; you never write it by hand. Metrics are computed over observations, and gates check metrics.

## Example: a golden set of product pages

The task extracts a product from the HTML of a store page. The golden set is a JSON file with the expected fields of each page. Some fields are known gaps (the page does not show them), and a title that only differs by a condition suffix is excluded as a known convention.

```ts
import { BigDecimal, Config, Context, Effect, Layer, Option, Schema } from "effect";
import { NodeServices } from "@effect/platform-node";
import { Compare, Dataset, Eval, Gate, Metric, Scorer } from "@computis/effect-eval";
import * as EvalTest from "@computis/effect-eval/vitest";

const ProductSchema = Schema.Struct({
  category: Schema.String,
  currency: Schema.optionalKey(Schema.String),
  price: Schema.String,
  title: Schema.String,
});
type Product = typeof ProductSchema.Type;

const GoldenPageSchema = Schema.Struct({
  expected: ProductSchema,
  gaps: Schema.Array(Schema.Struct({ key: Schema.String, reason: Schema.String })),
  html: Schema.String,
  id: Schema.String,
  store: Schema.String,
});
type GoldenPage = typeof GoldenPageSchema.Type;

class ProductExtractor extends Context.Service<
  ProductExtractor,
  { readonly extract: (html: string) => Effect.Effect<Product> }
>()("ProductExtractor") {}

const read = (key: keyof Product) => (product: Product) => Option.fromNullishOr(product[key]);

const productFields = Scorer.fields<GoldenPage, Product>({
  expected: (page) => page.expected,
  fields: [
    { compare: Compare.exact(), group: "pricing", key: "currency", read: read("currency") },
    {
      compare: Compare.mapInput(BigDecimal.fromStringUnsafe)(
        Compare.tolerance(BigDecimal.fromStringUnsafe("0.01")),
      ),
      group: "pricing",
      key: "price",
      read: read("price"),
    },
    { compare: Compare.exact(), group: "catalog", key: "category", read: read("category") },
    {
      compare: Compare.tokenSimilarity(),
      exclude: ({ actualValue }) =>
        Option.exists(actualValue, (title) => title.endsWith(" (Renewed)"))
          ? Option.some("condition suffix")
          : Option.none(),
      group: "catalog",
      key: "title",
      read: read("title"),
    },
  ],
  gap: (page, key) =>
    Option.map(
      Option.fromNullishOr(page.gaps.find((entry) => entry.key === key)),
      (entry) => entry.reason,
    ),
  onlyActual: Scorer.onlyActualPolicies.exclude,
});

export const productExtraction = Eval.make({
  dataset: Dataset.json(GoldenPageSchema, "evals/products/golden.json", {
    id: (page) => page.id,
    tags: (page) => [`store:${page.store}`],
  }),
  gates: [
    Gate.missedOnlyOnGaps,
    Gate.min(Metric.accuracy, 0.9),
    Gate.by("group:pricing", Gate.min(Metric.accuracy, 0.98)),
    Gate.max(Metric.excluded(Scorer.unclassified), 0),
  ],
  name: "product-extraction",
  output: ProductSchema,
  score: productFields,
  task: (page) => ProductExtractor.use((extractor) => extractor.extract(page.input.html)),
  timeout: "3 minutes",
});
```

What each piece does:

- `Scorer.fields` emits one observation per field, tagged `group:<group>`. A field that neither side has emits nothing.
- `exclude` turns a known difference into an `excluded` observation with its reason. `excluded` on a field always excludes it.
- `onlyActual: "exclude"` excludes a field that only the output has, with the reason `extra`, also when the field is `excluded` (a pending field the output alone has is `extra`, as in the golden set). Use `"falsePositive"` to count it as wrong.
- `leaves` (not shown) checks every leaf path of the record that no field `covers`. A path that `rule` cannot classify becomes `excluded("unclassified")`, and the last gate above fails on it. When the task failed there is no record to check: the case gets only the `errored` fields.
- `gap` turns a `missed` field into a `gap` when it gives a reason for the case and the field `key`. A known gap the output fills reads "right (gap closed)" in the summary. `Gate.missedOnlyOnGaps` passes while every missed field has a known reason.
- `output` lets the run store each output, so you can score it again later (see [History and rescore](#history-and-rescore)).

Run it as a vitest suite:

```ts
declare const productExtractorLayer: Layer.Layer<ProductExtractor>;

EvalTest.describe(productExtraction, {
  layer: Layer.merge(productExtractorLayer, NodeServices.layer),
  skipUnless: { apiKey: Config.Redacted("OPENROUTER_API_KEY") },
});
```

## Example: a ticket router with variants, trials and gates

The task routes support tickets to a queue, in pages of 20. A `setup` seeds the tickets in an inbox once per trial, and its value reaches every call of the task; a task that takes a setup value does not compile without `setup`. Two models and two reasoning settings give four variants. Each case runs three times per variant.

```ts
import { Context, Effect, Layer, Option } from "effect";
import { NodeServices } from "@effect/platform-node";
import {
  Dataset,
  Eval,
  Execution,
  Gate,
  History,
  Metric,
  Reporter,
  Reporters,
  Runner,
  Scorer,
  Variant,
} from "@computis/effect-eval";

interface Ticket {
  readonly id: string;
  readonly subject: string;
  readonly queue: string | null;
}

const Model = Context.Reference<string>("Model", { defaultValue: () => "google/gemini-2.5-flash" });
const Reasoning = Context.Reference<boolean>("Reasoning", { defaultValue: () => false });

class TicketRouter extends Context.Service<
  TicketRouter,
  {
    readonly seed: (tickets: readonly Ticket[]) => Effect.Effect<string>;
    readonly route: (
      inbox: string,
      page: readonly Ticket[],
    ) => Effect.Effect<readonly (string | null)[]>;
  }
>()("TicketRouter") {}

declare const tickets: readonly Ticket[];
declare const ticketRouterLayer: Layer.Layer<TicketRouter>;

export const ticketRouting = Eval.makeBatched({
  dataset: Dataset.fromIterable(tickets, { id: (ticket) => ticket.id }),
  execution: Execution.batched(20),
  gates: [
    Gate.min(Metric.accuracy, 0.8, { on: Gate.bounds.lowerBound }),
    Gate.max(Metric.falsePositives, 2),
    Gate.max(Metric.errored, 0),
  ],
  name: "ticket-routing",
  score: Scorer.label<Ticket, string | null>({
    actual: Option.fromNullishOr,
    expected: (ticket) => (ticket.queue === null ? Scorer.absent : Scorer.present(ticket.queue)),
  }),
  setup: TicketRouter.use((router) => router.seed(tickets)),
  task: (page, inbox) =>
    TicketRouter.use((router) =>
      router.route(
        inbox,
        page.map((entry) => entry.input),
      ),
    ),
  trials: 3,
});

export const variants = Variant.matrix({
  model: [
    Variant.make("gemini-flash", Layer.succeed(Model, "google/gemini-2.5-flash")),
    Variant.make("gpt-5-mini", Layer.succeed(Model, "openai/gpt-5-mini")),
  ],
  reasoning: [
    Variant.make("off", Layer.succeed(Reasoning, false)),
    Variant.make("on", Layer.succeed(Reasoning, true)),
  ],
});

export const program = Runner.run(ticketRouting, { variants }).pipe(
  Effect.tap(Runner.check),
  Effect.provide(ticketRouterLayer),
  Effect.provide(Reporter.layer([Reporters.terminal(), History.reporter])),
  Effect.provide(History.layerFileSystem()),
  Effect.provide(NodeServices.layer),
);
```

- `Variant.matrix` builds every combination. Its names read `model=gemini-flash · reasoning=on`, and its layer merges the layers of the combination. Its type promises only the services that every alternative of an axis provides. The variants of a run need distinct names, and at least one is needed: an empty list or a repeated name fails with `EvalConfigError` before the run.
- With `Execution.batched(n)` the task gets up to `n` cases in order and returns one output per case. A short array errors the cases it misses. Batches run one at a time unless you pass `concurrency`. `Execution.whole` hands the task the whole dataset; `Execution.perCase()` (the default of `Eval.make`) one case.
- `Scorer.label` gives one observation per case. An expected `null` queue means no queue is expected: returning none is a correct abstention, returning one is a false positive.
- `Gate.min(…, { on: "lowerBound" })` checks the lower bound of the interval, which is safer on a small dataset. Every gate holds per variant, over the observations of all trials.
- `Runner.check` fails with `EvalGateFailed`, which lists every failed gate and up to 20 observations that broke it in the error; the run, JSON events and history retain the full list.
- With more than one trial each variant reports the mean and standard deviation of every metric across trials, the counts (right, wrong, missed, …) as well as the ratios, pass@k, pass^k and the observations whose verdict changes between trials. Excluded and unscored observations stay out of them, and a metric that no trial can measure has no mean. pass@k and pass^k always use the k you asked for: an observation measured in fewer than k trials stays out of them, the summary says how many it left out, and when none was measured k times it reads "unavailable" with the reason. `View.summary` shows them in a "Trials" section, so the terminal, Markdown and HTML reports have it.

Other eval settings: `timeout` and `retry` (a `Schedule`) apply to every call of the task, `hash` names the input when it is not JSON, and `budget` stops runaway runs. `trials` must be a positive integer, or the run fails with `EvalConfigError` before it calls anything. `budget.confirmAbove` refuses a plan with more task calls than that unless the run is `confirmed`. `budget.maxCalls` errors the cases left once the task calls started reach the limit. Every attempt of a retry is one task call, counted toward `maxCalls` when it starts, and checks the budget first. A `setup` that fails spends no task call: its cases error with the setup failure, and later trials and variants keep the budget. The usage of the run holds the calls `Usage` recorded; an attempt that times out or is interrupted keeps the usage the model recorded before it stopped, or counts as one call with an unknown cost when it recorded none. `Usage.trackLanguageModel` records `generateText`, `generateObject` and `streamText`. A call that returns a response counts the `usage` of that response, once, whether or not the model calls the telemetry span transformer; a failed or interrupted call counts the usage the telemetry saw, if any. The judge counts its calls the same way. For streams, a stream counts as one call, with the tokens of its finish part, recorded when the stream ends, fails or is interrupted (with an unknown cost when no finish part arrived). Once the budget is spent the retries stop and the case errors as `BUDGET`. Recording usage is atomic: a cancellation never keeps it in the case without the run's ledger, or the reverse. When a run is cancelled, the usage the task and the scorers recorded for cases it had not reported yet still counts: `RunFinished` carries it in `unreportedUsage`, and the folded run, the summary and the history add it to the variant, never twice. Calls a scorer records, such as a judge, count in the usage of the run, under their label, but not toward `maxCalls` or the plan. When any call that spent tokens has no price, the cost of the run, and of its label, is unknown: the summary reads "cost unknown" and the cost chart leaves the variant out.

A task that fails does not fail the run: its cases become `errored` observations, scored like any other. When a task error should still fail the eval, add `Gate.max(Metric.errored, 0)`, as the ticket router and citation examples do. An eval that tolerates failures, such as a golden set that scores a failed page as zero, leaves the gate out. A task that throws while it builds its effect errors its cases like a task that fails. An output the eval cannot encode with its `output` schema is not stored: the case records an `unencodable:` reason, the summary lists it under "Outputs not stored", and a rescore errors the case with that reason. The runner logs a warning with the reason; for a sensitive eval the warning names only the case, because a codec's error can quote the output. Encoding can be cancelled like the task: an encoder that hangs does not hold up a cancellation, and the run still finishes with `interrupted: true` and keeps the usage of the case.

## Example: citation matching, made-up and real data

One case is an article with many claims. The task matches each claim to the sources that support it. `Scorer.each` splits the case into one sub-case per claim, and `Scorer.set` gives partial credit when the task finds some of the sources of a claim.

The same eval runs on two datasets: made-up articles that live in the repository, and real data that must never leave the machine. The real dataset comes from a path in `CITATION_EVAL_DATASET`; when the variable is not set, it is empty. `Dataset.guard` fails the run when an input matches a privacy rule or a denylist token. For a file dataset it scans both the raw entry and the decoded input, so a string a schema default or transformation adds is checked too; a decoded input that is not JSON cannot be scanned and fails the guard. `sensitive: true` hides observation details, failures and outputs from every reporter that does not accept sensitive data. A dataset from `Dataset.optional` is sensitive by itself, so the real eval would hide them even without the flag.

```ts
import { Config, Context, Effect, Equivalence, Option, Schema } from "effect";
import { Compare, Dataset, Eval, Gate, Metric, Privacy, Scorer } from "@computis/effect-eval";

const ArticleSchema = Schema.Struct({
  claims: Schema.Array(
    Schema.Struct({
      gap: Schema.NullOr(Schema.String),
      id: Schema.String,
      sources: Schema.Array(Schema.String),
      text: Schema.String,
    }),
  ),
  id: Schema.String,
});
type Article = typeof ArticleSchema.Type;

class CitationMatcher extends Context.Service<
  CitationMatcher,
  { readonly match: (article: Article) => Effect.Effect<ReadonlyMap<string, readonly string[]>> }
>()("CitationMatcher") {}

const score = Scorer.each(
  {
    actual: (matches: ReadonlyMap<string, readonly string[]>) => matches,
    expected: (article: Article) =>
      article.claims.map((claim) => ({ id: claim.id, input: claim, tags: [] })),
    gap: (claim) => Option.fromNullishOr(claim.gap),
  },
  Scorer.set({
    actual: Option.getOrElse(() => []),
    compare: Compare.subset(Equivalence.String),
    expected: (claim) => Scorer.present(claim.sources),
    show: (source) => source,
  }),
);

const privacy: Privacy.Privacy = {
  denylist: Privacy.denylist("EVAL_DENYLIST"),
  rules: [{ name: "email", pattern: /[\w.+-]+@[\w-]+\.[\w.]+/u }],
};

const shared = {
  gates: [
    Gate.min(Metric.precision, 0.95),
    Gate.min(Metric.recall, 0.8),
    Gate.missedOnlyOnGaps,
    Gate.max(Metric.errored, 0),
  ],
  score,
  sensitive: true,
  task: (article: Dataset.Case<Article>) =>
    CitationMatcher.use((matcher) => matcher.match(article.input)),
};

declare const madeUpArticles: readonly Article[];

export const madeUp = Eval.make({
  ...shared,
  dataset: Dataset.fromIterable(madeUpArticles, { id: (article) => article.id }),
  name: "citations",
});

const realArticles = Dataset.guard(privacy)(
  Dataset.optional(Config.String("CITATION_EVAL_DATASET"), ArticleSchema, {
    id: (article) => article.id,
  }),
);

export const real = Eval.make({
  ...shared,
  dataset: realArticles,
  name: "citations-real",
});
```

The observation key of each claim is the claim id, and the tags of the article pass to its claims.

The inner scorer of `Scorer.each` gets the sub-case as its case and, as its output, an `Option` of the item: `Option.some(value)` when the map of `actual` has the sub-case id, `Option.none()` when it does not. That is why `actual` above reads `Option.getOrElse(() => [])`: a claim the task left out of the map counts as no source found. A `Scorer.label` inside `Scorer.each` takes the option as it is, with `actual: (item) => item`, or `Option.flatMap(…)` to read a field of the item. `gap` gives the reason a sub-case is a known gap, from its input and its id: every observation of that claim carries the gap, so a missed claim reads `gap` and `Gate.missedOnlyOnGaps` lets it pass.

A key is a path below its case: `Scorer.label` and `Scorer.set` score the case itself (the empty key, `Observation.rootKey`) unless you give them a `key`, a field or a judge adds one segment, and `Scorer.each` puts the sub-case id in front of every inner key (`<claim id>/<key>`, or just the claim id for a label or set). An id in the map of `actual` is present even when its value is `null`; only an id that is not in the map is absent. Segments escape `/` and `\`, and an empty segment has its own mark, so two sub-cases never merge in comparisons, trials, case maps or rescores. When two scorers of `Scorer.all` give a case the same key, such as two labels without a `key`, the run fails with `EvalConfigError` before it reports the case. A claim with no expected source and none found is a correct abstention.

In vitest, `EvalTest.guard("citations-real", realArticles, NodeServices.layer)` adds a privacy test that runs even when the eval itself is skipped for a missing key, so CI checks the data on every push.

## Datasets

| Constructor                                  | Reads                                             |
| -------------------------------------------- | ------------------------------------------------- |
| `Dataset.fromIterable(entries, identify)`    | values in memory                                  |
| `Dataset.fromEffect(effect, identify)`       | values an effect returns                          |
| `Dataset.stream(stream, identify)`           | values a stream emits                             |
| `Dataset.json(schema, path, identify)`       | a JSON array, decoding each entry with the schema |
| `Dataset.jsonl(schema, path, identify)`      | one JSON value per line                           |
| `Dataset.directory(folder, options)`         | every file with an extension, in name order       |
| `Dataset.optional(config, schema, identify)` | a JSON file named by a config, or nothing         |

`identify` gives the id (`id`) and the tags (`tags`) of an input. Put `Dataset.skip(id, reason, { tags })` among the entries to list a case that cannot run yet; it shows in the report. A tag filter keeps the skips that carry one of its tags, so `--tag store:outlet` still lists the skipped pages of that store. `Dataset.filter({ ids, tags, limit })` keeps the matching entries and then the first `limit` of them, skips included, as a golden set limits its pages. `Dataset.sample({ size, seed, stratifyBy })` and `Dataset.concat(other)` also return a new dataset. A sample with the same seed draws the same cases; `stratifyBy: "group"` keeps the share of each `group:<name>` tag.

A dataset carries a `sensitive` flag. `Dataset.optional` sets it, `Dataset.asSensitive(dataset)` sets it on any dataset, and `filter`, `sample`, `guard` and `concat` keep it. A run is sensitive when its eval or its dataset is.

The input hash that rescore checks is the hash of the canonical JSON of the input the task receives, after decoding: a changed schema default or transformation changes it even when the file did not change. An input that is not JSON, such as a `Date` a file schema decodes, is hashed only through the eval's `hash` setting; without it, it stays `unhashed` and rescore errors its cases as `stale`.

## Comparators and metrics

`Compare` functions return an `Agreement` for two present values: `exact(equivalence?)`, `normalizedText()` (case, outer and repeated spaces), `tolerance(bigDecimal)`, `numericTolerance(n, { relative? })`, `similarity()` (normalized Levenshtein on code points), `tokenSimilarity({ minContained? })` (word by word, accent and punctuation blind), `subset(equivalence)` (two empty sets are `Exact`; an empty actual set against a non-empty expected one is `Different`), `custom(f)` and `mapInput(f)`.

| Metric          | Kind  | Definition                                                                                                  |
| --------------- | ----- | ----------------------------------------------------------------------------------------------------------- |
| `answered`      | ratio | answers given, not errored, over the observations not excluded                                              |
| `precision`     | ratio | right answers over the answers given                                                                        |
| `recall`        | ratio | right answers over the values expected                                                                      |
| `accuracy`      | ratio | credit (right 1, partial its score) over the evaluated observations whose expected value is known           |
| `meanAgreement` | ratio | mean credit where both sides are present                                                                    |
| counts          | count | `right`, `partial`, `wrong`, `missed`, `gaps`, `unscored`, `errored`, `falsePositives`, `excluded(reason?)` |

Ratios carry a Wilson interval (`Statistics.wilson(successes, n, { confidence })`, 0.95 by default), or a seeded bootstrap interval when partial credit is involved; `meanAgreement` always takes the bootstrap interval, as its definition asks, so a run where every agreement is exact has the interval [1, 1]. A ratio with no denominator is not measurable, and a gate on it fails. `Metric.by("group")` summarizes each `group:<name>` tag; an observation that repeats a tag counts once in its group.

Read the numbers of a run with `Metric.read(summary, metric)`. It works on `variant.summary` and on every group of `variant.groups`. A count metric gives a number. A ratio metric gives its `Estimate`: `hits` is the numerator, `n` the denominator, and `value` is `hits / n`, or none when `n` is 0. `interval` is the confidence interval. For `accuracy` and `meanAgreement`, `hits` is the credit summed over the observations, so a partial answer adds its score rather than 1.

```ts
const numbers = run.variants.map((variant) => {
  const precision = Metric.read(variant.summary, Metric.precision);
  return {
    answers: precision.n,
    pending: Metric.read(variant.summary, Metric.excluded("pending")),
    rightAnswers: precision.hits,
    variant: variant.variant,
    wrong: Metric.read(variant.summary, Metric.wrong),
  };
});
```

`summary.counts` and `summary.ratios` are records keyed by metric name, and the views read them. In your own code use `Metric.read`: it is typed by the metric, and an exclusion reason the run never saw reads 0.

`Judge.make` is a scorer that asks a model to grade the output with a rubric schema. The judge model is a fixed `Variant`, and a judge failure errors the observation; an interruption of the judge, or of any scorer, interrupts the run instead. Its calls and tokens count once in the usage of the run under the label `judge:<name>` (`usage.labels`), also when the model is tracked with `Usage.trackLanguageModel`, and a response that does not match the rubric keeps the tokens it spent. The run stores the judge's result with the case: the observation it produced (agreement, expected state, detail and `note`), written through the observation schema. It never stores the model's answer or the rubric verdict. The entry is keyed by the observation path inside the case (a judge under `Scorer.each` keeps one result per sub-case, as `<id>/judge:<name>`) and a hash of the cache format, the case, the judge name, the rubric schema, the decoded default values of the rubric's fields, the judge's `version`, the name of the judge model, the prompt, the output, the shown and expected text and the tags. A rescore takes a stored result as it is while that hash is unchanged: it neither decodes it with the rubric nor calls `agreement` or `note` again, so a cached result is the fresh one by construction, whatever codec the provider uses. It keeps the reused result in its own run, so a rescore of a rescore reuses it too. It asks the model only otherwise, so a changed rubric, default, `version`, judge model, prompt or output always asks again. A changed `agreement` or `note` alone keeps the stored result; rename the judge, or change its `version`, to grade again. A rubric is reused only when it can be fingerprinted or the judge has a `version`: a transformation (`decodeTo`, `transform`, a built-in transformed schema), a declaration, a recursive schema, or a default that is not JSON makes it unfingerprintable, and without a `version` such a judge is asked on every rescore. Bump `version` when you change a rubric that has transforms. A result that does not decode back to the same observation is not stored, and the rescore asks again. Runs stored by earlier versions of the cache are never reused. An output that is not JSON enters the hash through the `show` option; without `show` such an output is never reused, and the judge asks again. When the task failed, the judge does not run and the observation errors with the expected state the case has, so a case with no expected output or an unknown one stays out of recall. A case whose expected value is unknown also stays out of accuracy when its task fails, as it does when the task answers.

## Reading a run

| To count                                     | Read                                                          |
| -------------------------------------------- | ------------------------------------------------------------- |
| Missed values, known gaps included           | `Metric.missed` + `Metric.gaps`                               |
| Share of observations answered               | `Metric.answered`                                             |
| Share of expected values found               | `Metric.recall`                                               |
| Right answers over the known expected values | `Metric.accuracy`, not `Metric.answered`                      |
| Answers given                                | `Metric.read(summary, Metric.answered).hits`                  |
| Pending and skipped fields                   | `Metric.excluded("pending")` and `Metric.excluded("skipped")` |
| Skipped cases                                | `run.skipped`, not excluded field observations                |

The summary has an "Exclusions" table with every reason, including custom reasons. It counts all observations, including those of failed cases. To count pending and skipped fields only on the cases whose task succeeded, filter by task outcome first:

```ts
import { Run } from "@computis/effect-eval";

const successful = Metric.summary(
  Run.succeededObservations(run)
    .filter((scored) => scored.variant === "default")
    .map((scored) => scored.observation),
);
const pending = Metric.read(successful, Metric.excluded("pending"));
const skipped = Metric.read(successful, Metric.excluded("skipped"));
```

`Run.succeededObservations` matches case, variant and trial against the stored task outcomes; an excluded field can belong to a failed page, so filtering on the observation verdict is not equivalent. A failed batch errors every case, including correct abstentions: an outage is not a right answer. Add `Gate.max(Metric.errored, 0)` when outages must fail the eval. Unknown expected values stay out of accuracy even when the task fails.

Use `gap` on `Scorer.each` or `Scorer.fields` instead of wrapping their observations. The inner scorer of `Scorer.each` receives `Option<item>`; the citation example shows the absent-item fallback. Read ratios from `Metric.read`, including group summaries, rather than parsing rendered estimates or multiplying `value * n`. Views round ratios for display; typed values retain their precision. `EvalTest.checkCase(eval.gates, run, id)` exposes the same case decision as `split: "case"` without a child Vitest process. It checks only observations that break a gate which failed for the whole run; the suite still needs its separate overall gates test (for example for a missing baseline or an unmeasurable ratio).

## Reporters

The runner prints nothing. It publishes events to the reporters of `Reporter.layer` and returns the `Run` folded from the same events. The layer needs the services of every reporter in its list, such as `History` for `Reporters.history` and `FileSystem` and `Path` for `Reporters.markdown`; their union is inferred, so `Reporter.layer([Reporters.history, Reporters.markdown()])` needs no type argument.

| Reporter                                              | Output                                       |
| ----------------------------------------------------- | -------------------------------------------- |
| `Reporters.terminal(options)`                         | progress lines and the summary view          |
| `Reporters.markdown({ file?, compareFile?, write? })` | the summary as Markdown, to a file or stdout |
| `Reporters.html({ file, compareFile? })`              | the dashboard as one HTML file               |
| `Reporters.json({ file?, write? })`                   | one JSON line per event                      |
| `Reporters.history`                                   | the run in the `History` service             |
| `Reporter.silent`                                     | nothing                                      |

Write your own with `Reporter.make({ name, onRunStarted, onCaseFinished, onRunFinished, onComparison, … })`, `Reporter.fromStream(name, consume)` or `Reporter.process(name, command, args)`, which pipes JSON lines to a child process. `onRunFinished` receives the run folded from every event of the run, also when the reporter is sliding and dropped some of them. `onComparison(base, head)` draws a comparison: the terminal reporter prints it as text and the Markdown one as Markdown. A reporter that writes a file writes the comparison to its own file, `compareFile`, by default the report's name with `.compare` before the extension (`.eval/report.html` → `.eval/report.compare.html`), so the run report stays; `Reporter.compare(base, head)` sends one to every installed reporter that has it, redacted for those that do not accept sensitive data when either run is sensitive. Then adjust it:

- `Reporter.required(reporter)`: its failure fails the run with `EvalReporterFailed`, also when it throws or when a resource it holds fails to release. Other reporters can fail, or throw; the run lists them in `failedReporters`. A failed reporter is logged as a warning with its error; for a sensitive run, or when the reporter read a sensitive run from the history unredacted (through `History.snapshot`, `History.load` or `History.resolve`), the warning names only the reporter, and the `cause` of `EvalReporterFailed` is a notice instead of the reporter's error, because that error can quote the output a reporter that accepts sensitive data was given. The same holds for `Reporter.compare`. `RunFinished` carries the ones that had failed when it was emitted, so the history keeps them; one that fails while the run drains shows only on the returned `Run`. A reporter's resources live for one run and are released before the run returns.
- `Reporter.sliding(reporter)`: a slow reporter may drop progress events, never lifecycle ones. The events it gets keep their order, so `RunStarted` comes first and `RunFinished` last.

Every reporter sees `RunStarted` before any other event and the sequence numbers strictly increasing, also when cases run concurrently.

- `Reporter.acceptingSensitive(reporter)`: it sees details and outputs of sensitive runs. A reporter that does not accept them also gets sensitive runs of the history redacted: `History.snapshot` and the snapshot a View receives hide their details and outputs, whether the current run is sensitive or not.

```ts
const slack = Reporter.make({
  name: "slack",
  onRunFinished: (run) => Effect.log(`${run.eval}: ${View.outcomeLabel(run)}`),
});

Runner.run(ticketRouting, { variants }).pipe(
  Effect.provide(Reporter.layer([Reporter.required(slack), Reporters.terminal()])),
);
```

## History and rescore

`History.layerFileSystem(root)` stores each run under `<root>/<eval>/<run id>.jsonl` with an `index.jsonl` per eval; the default root is `.eval/history`. `History.layerMemory` keeps runs in memory, for tests.

A selector names a stored run: `History.id(id)`, `History.latest`, `History.baseline(branch?)` (the newest finished run on that branch that is not a rescore; without a branch, the base branch, read when the selector is looked up), `History.onBranch(branch)` or `History.fromFile(path)`. `History.parseSelector` reads `latest`, `baseline`, a `.jsonl` path or an id. `latest`, `baseline` and `onBranch` skip a run that did not finish: one that was interrupted, or whose run failed, for example because a variant layer failed. An id still loads it.

`History.resolve(eval, selector, variants)` looks up a baseline for each variant: the newest matching run that has that variant. The single-variant runs that `EvalTest.describe` saves therefore serve as the baseline of each model, and of a CLI run of all of them. An id or a file is taken whole. The runner resolves its baselines once, before the run, and the gates, the summary's "Δ baseline" and the CLI comparison all use those same runs.

- `History.load(eval, selector)` and `History.list(eval)` read the history. `History.id` takes an id or a prefix: an exact id wins, and a prefix that matches more than one run fails with `EvalHistoryError`, which lists them.
- `Gate.noRegressions(selector)` fails on every observation that was right in that run and is not right now.
- `Run.compare(run, baseline)` pairs the observations of the two runs by variant, case, key and trial. It returns the `regressions` and `fixes`, the `added` and `removed` observations, the `transitions` between verdicts with their counts per variant, and one `deltas` entry per variant and ratio metric. A delta and its seeded paired bootstrap interval both use only the pairs the metric measures in both runs, so they describe the same observations; `before` and `after` in a delta are the values over those pairs, and the `added` and `removed` lists name the rest. Only the accuracy delta carries a McNemar `pValue`, computed from the regressions and fixes among the pairs that accuracy evaluates on both sides.
- `View.compare(base, head)` shows that comparison; its delta chart draws the interval of each delta. It lists the added and removed observations, at most twenty each, with a "+N more" line for the rest. The "Δ baseline (paired)" column of `View.summary`, and so of the terminal, Markdown and HTML reports, takes its value from the same `Run.compare` deltas, so a case added to or removed from the dataset never reads as a change of the model; a line under the table counts the observations it left out.
- `Runner.rescore(eval, { from: selector })` scores the stored outputs again with the current scorer, without calling the task. It needs `output` on the eval. A case whose input hash changed errors as `stale`; a case without a stored output errors as `missing`, or with the reason the output was not stored. `Runner.rescoreRun(eval, run)` does the same with a run you already have. Its plan counts 0 task calls, and the CLI takes the variant names from the stored run without parsing them, so a model no longer in the variant list can still be rescored. A rescore of a sensitive run is sensitive, and asking for a variant the stored run does not have fails with `EvalConfigError`.

## eval.config.ts

The CLI and the reporter names read `eval.config.ts` (or `.mts`, `.js`, `.mjs`) from the working folder or one of its parents. A reporter module path in the config is relative to the folder of the config; a `--reporter` path is relative to the working folder.

```ts
import { ChartHtml, ChartMermaid, EvalConfig, View } from "@computis/effect-eval";
import * as ChartUnicode from "@computis/effect-eval/chart-unicode";

export default EvalConfig.define({
  history: { baseBranch: "main", directory: ".eval/history" },
  renderer: View.firstOf(ChartHtml.renderer(), ChartMermaid.renderer(), ChartUnicode.renderer()),
  reporters: ["terminal", "history", ["html", { file: ".eval/report.html" }]],
  view: View.summary,
});
```

`reporters` takes built-in names (`terminal`, `html`, `markdown`, `json`, `silent`, `history`), `[name, { file, compareFile?, title? }]` for the built-ins that write a file (`html`, `markdown`, `json`), `["process", { command, args?, name? }]` for `Reporter.process`, reporter values (`Reporter.process(…)` included) or paths of modules that export a reporter by default. `view` replaces the View of the terminal, Markdown and HTML reporters; `renderer` and `theme` draw its charts. One renderer serves all three: each report takes only a drawing it can show, so with `View.firstOf` the HTML report gets the Vega chart, the Markdown one the Mermaid chart and the terminal the Unicode one.

The base branch of `History.baseline` comes from `EVAL_BASE_BRANCH`, then from `history.baseBranch`, then defaults to `main`.

## CLI

`EvalCli.command` turns an eval into an `effect/cli` command.

```ts
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { Command } from "effect/cli";
import { EvalCli } from "@computis/effect-eval";

const cli = EvalCli.command({
  eval: () => ticketRouting,
  name: "ticket-routing",
  variants: {
    defaults: ["gemini-flash"],
    parse: (name) => Variant.make(name, Layer.succeed(Model, name)),
  },
});

cli.pipe(
  Command.run({ version: "1.0.0" }),
  Effect.provide(ticketRouterLayer),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
```

| Flag                            | Effect                                                          |
| ------------------------------- | --------------------------------------------------------------- |
| `--variant <name>`              | run this variant; repeat it for more, a repeated name runs once |
| `--case`, `--tag`, `--limit`    | filter the dataset                                              |
| `--sample <size>[:<seed>]`      | run a seeded sample                                             |
| `--trials`, `--concurrency`     | override the eval; `--trials` must be positive                  |
| `--reporter <name or path>`     | replace the reporters of `eval.config.ts`; repeat it for more   |
| `--format text\|json\|markdown` | replace the stdout reporter; history and file reporters stay    |
| `--no-history`                  | keep the run out of the history, whatever reporter stores it    |
| `--rescore <run>`               | score a stored run again: an id, `latest` or `baseline`         |
| `--baseline <run>`              | compare with a stored run and fail on regressions               |
| `--yes`                         | confirm a plan above `budget.confirmAbove`                      |

The command prints the plan, warnings and logs to stderr, never to stdout, and exits with a non-zero code when a gate fails. `--format` replaces every built-in that writes to stdout: a name, a `[name, options]` without a `file`, or a value whose `destination` is `stdout`, such as `Reporters.terminal()` or `Reporters.json()`. Reporters that write a file (`Reporters.markdown({ file })`, a `["json", { file }]`, html), in any of these forms, the history and custom reporters stay. It loads the `--baseline` run once, before the run, and uses it for the gate, for the "Δ baseline" of the summary in every report (`Runner.run`'s `reportBaseline`) and for the comparison, which goes through the chosen reporters: the terminal reporter prints it as text, the Markdown one as Markdown, a file reporter writes it to its `compareFile` next to the run report, and `--format json` keeps stdout to JSON lines. Two subcommands read the history without calling the task: `history [--branch] [--variant] [--limit]` lists the runs, with the accuracy of each variant, and `compare <base> <head> [--reporter] [--format]` compares two of them through the same reporters, redacted when either run is sensitive. The run and both subcommands read and write the history of the eval's own `name`; `name` of the command is only the CLI word, so a command `golden-set` for the eval `product-extraction` keeps one history. The subcommands take the command's own flags too and build the eval from them to read its name, without running it. `evalName` names the history without building the eval; when it is not the eval's name, the run fails with `EvalConfigError`. A reporter module is replaced by `--format` like a value: by its `destination` once it is loaded.

## Vitest

`EvalTest.describe(eval, options)` declares a suite with one test per variant. The test fails when a gate fails. Like `Runner.run`, it refuses an empty variant list or two variants with the same name, with `EvalConfigError`, before it registers any test. The terminal summary prints after the suite, without progress lines, whether the terminal reporter is named or given as `Reporters.terminal()`.

- `layer` provides the services of the eval, plus `FileSystem`, `Path` and `ChildProcessSpawner`. The suite reads the branch and commit with `Git.layerProcess`; a `Git` service in `layer` overrides it.
- `skipUnless` takes configs, such as an API key. When one is missing, the suite is skipped. `variants` receives their values.
- `reporters` and `history` default to those of `eval.config.ts`, as in the CLI. `reporters` replaces them, and `history: false` keeps runs out of the history. Turning history off, here, with `history.enabled: false` or with `--no-history`, drops every reporter named `history`, also one given as a value, a module or wrapped in `Reporter.required`.
- `split: "case"` runs each variant once and declares one test per case, which fails when an observation of that case breaks a failed gate, also past the twenty violations the run lists, plus a `gates` test for every gate. A partial answer the gates accept passes.
- `timeout` defaults to 30 minutes.

`EvalTest.guard(name, dataset, layer)` adds a test that loads the dataset, so its privacy guard runs on CI.

Inside `it.effect`, timeouts of the task and timestamps of the run use the real clock, not the `TestClock`.

## Views, charts and renderers

A `View` is a list of blocks: sections, rows, tabs, texts, badges, tables and figures. `View.summary(run, history)`, `View.compare(base, head)` and `View.dashboard(run, history)` build the standard ones. The summary has a "Cases" section with the cases that succeeded and failed per variant and trial, counted from the stored outputs and their failures (so a page is one case however many fields it has), and a "Groups" section with the accuracy, recall and precision of each `group:` tag when the run has groups. A figure holds a `Chart` and a table to show when no renderer can draw it.

| Renderer                                              | Draws                                                                 |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| `ViewText.render(view, { width, color, renderer? })`  | text for the terminal; a row folds into a column when it does not fit |
| `ViewMarkdown.render(view, { renderer? })`            | Markdown                                                              |
| `ViewHtml.render(view, { title, renderer?, theme? })` | one HTML page, every text escaped                                     |

| Chart renderer                      | Output                                                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `ChartUnicode.renderer({ color? })` | bars, maps and plots in Unicode                                                                                 |
| `ChartVega.terminal({ protocol? })` | a PNG inline with the kitty or iTerm protocol, or `terminal-image`; none on CI or when stdout is not a terminal |
| `ChartVega.svg()`                   | an SVG through Vega-Lite                                                                                        |
| `ChartMermaid.renderer()`           | a Mermaid `xychart-beta` for trend, variants and delta charts                                                   |
| `ChartHtml.renderer()`              | a `vegaEmbed` call for an HTML page                                                                             |

A chart renderer returns a `Drawing`, `View.drawing(kind, content)`, whose kind says where it can go: `html` (`ChartHtml`, `ChartVega.svg`), `markdown` (`ChartMermaid`), `terminal` (`ChartVega.terminal`, coloured `ChartUnicode`) or `text` (plain `ChartUnicode`). Each view takes only the kinds it can show and falls back to the table otherwise: HTML puts a `text` drawing escaped in a `<pre>` and inserts only `html` as markup, Markdown puts `text` in a code fence longer than any run of backticks in it, and the terminal takes `text` and `terminal`. `ChartHtml` escapes every `<`, `>` and `&` of the spec it embeds, so no label can close or open a script. `View.firstOf(a, b)` tries renderers in order and takes the first drawing of a kind the target accepts. `Chart.toVegaLite(chart, theme)` returns the Vega-Lite spec of any chart. `Theme.computis` is the default theme; pass your own `theme` to any renderer. A theme gives a colour to each of the eight verdicts, which case maps use.

Charts place runs by run id and show the date and short sha only as labels. `Chart.caseMap(runs)` returns one map per variant, with one column per run and trial and one row per observation path (`<case>/<key>`, or the case alone for the empty key); the Unicode renderer numbers the columns, lists their labels and gives every verdict its own glyph and colour, with a legend. `Chart.delta(comparison, variant)` and `Chart.transitions(comparison, variant)` draw one variant of a `Run.compare`. A cost the usage does not know stays out of the cost chart and reads `n/a` in its table, and a Mermaid trend with a missing point falls back to the table. Mermaid has no legend, so a trend draws one chart per variant, titled with the variant's name. A Mermaid label keeps its text on one line, and the block's fence is longer than any run of backticks in it, so no label can close it. The summary lists violations under each failed gate in a separate "Gate violations" section (up to 20 per gate), independently of the "To look at" cap (40 rows). Both caps show "+N more" and direct you to the JSON reporter or history, which retain every violation. Unclassified exclusions and observations breaking failed gates come first in "To look at". The "To look at" list of `View.summary` shows wrong, missed, partial and errored observations, `excluded("unclassified")` ones and right ones that still carry a known gap, and observation tables add a `note` column when an observation has `detail.note`.

```ts
const text = ViewText.render(View.summary(run), {
  color: true,
  renderer: View.firstOf(ChartVega.terminal(), ChartUnicode.renderer({ color: true })),
  width: 100,
});
const markdown = ViewMarkdown.render(View.summary(run), { renderer: ChartMermaid.renderer() });
const html = ViewHtml.render(View.dashboard(run), {
  renderer: ChartHtml.renderer(),
  title: run.eval,
});
```

## Errors

Every error is a `Data.TaggedError` with a `code`. A task that fails is never one of them: it becomes an `errored` observation.

| Error                | When                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `EvalDatasetError`   | a dataset file cannot be read or decoded, or two cases share an id                                                                                                             |
| `EvalPrivacyError`   | `Dataset.guard` finds a match; it lists every finding                                                                                                                          |
| `EvalBudgetExceeded` | the plan is above `confirmAbove` and the run is not confirmed                                                                                                                  |
| `EvalGateFailed`     | one or more gates failed                                                                                                                                                       |
| `EvalHistoryError`   | the history cannot be read, or no run matches the selector                                                                                                                     |
| `EvalConfigError`    | `eval.config.ts` or a reporter module cannot be loaded, `trials` is not a positive integer, or the variants are empty, repeat a name or are not in the stored run of a rescore |
| `EvalReporterFailed` | a required reporter failed                                                                                                                                                     |
| `EvalReporterError`  | `Reporter.process` exited with a non-zero code                                                                                                                                 |

## License

MIT
