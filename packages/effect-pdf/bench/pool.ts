import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Console, Effect, FileSystem, ManagedRuntime, Path } from "effect";
import { bilevelScanPdf, invoicePdf } from "./fixtures.ts";
import { attempt, formatNumber, median, nodePdfEngine, nodePdfEngineInProcess } from "./support.ts";
import type { PdfEngine } from "../src/engine.ts";
import { open } from "../src/index.ts";
import type { PdfDocument } from "../src/types.ts";

const CONCURRENT_DOCUMENTS = 16;
const LONG_DOCUMENT_LINES = 48 * 48;
const RENDER_WIDTH = 900;
const WARMUP_RUNS = 2;
const MEASURED_RUNS = 7;
const NANOSECONDS_PER_MILLISECOND = 1e6;
const SETTLE_MILLISECONDS = 20;

const engines = [
  { label: "in-process (thread principale)", layer: nodePdfEngineInProcess },
  { label: "1 worker", layer: nodePdfEngine({ size: 1 }) },
  { label: "2 worker", layer: nodePdfEngine({ size: 2 }) },
  { label: "4 worker", layer: nodePdfEngine({ size: 4 }) },
] as const;

const onDocument = <A, E>(
  bytes: Uint8Array,
  work: (document: PdfDocument) => Effect.Effect<A, E>,
) => Effect.scoped(Effect.flatMap(open(bytes), work));

const program = Effect.gen(function* effectPdfPoolBenchmark() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const [invoice, scan, contract] = yield* attempt(
    async () =>
      await Promise.all([invoicePdf(20), bilevelScanPdf(1), invoicePdf(LONG_DOCUMENT_LINES)]),
  );
  const scenarios: readonly {
    readonly title: string;
    readonly work: Effect.Effect<unknown, unknown, PdfEngine>;
  }[] = [
    {
      title: `${CONCURRENT_DOCUMENTS.toString()} fatture testuali di 1 pagina aperte insieme: classificazione + testo`,
      work: Effect.all(
        Array.from({ length: CONCURRENT_DOCUMENTS }, () =>
          onDocument(invoice, (document) => Effect.andThen(document.classify, document.text())),
        ),
        { concurrency: "unbounded" },
      ),
    },
    {
      title: `${CONCURRENT_DOCUMENTS.toString()} scansioni 1-bit aperte insieme: classificazione + immagini per il modello`,
      work: Effect.all(
        Array.from({ length: CONCURRENT_DOCUMENTS }, () =>
          onDocument(scan, (document) => Effect.andThen(document.classify, document.pageImages())),
        ),
        { concurrency: "unbounded" },
      ),
    },
    {
      title: "Contratto di 48 pagine: classificazione + testo",
      work: onDocument(contract, (document) => Effect.andThen(document.classify, document.text())),
    },
    {
      title: `Contratto di 48 pagine: render di tutte le pagine a ${RENDER_WIDTH.toString()} px`,
      work: onDocument(contract, (document) =>
        Effect.all(
          document.pages.map(({ index }) => document.render(index, { width: RENDER_WIDTH })),
          { concurrency: "unbounded" },
        ),
      ),
    },
  ];

  const measurements = yield* Effect.all(
    engines.map(({ label, layer }) =>
      Effect.acquireUseRelease(
        Effect.sync(() => ManagedRuntime.make(layer)),
        (runtime) =>
          Effect.all(
            scenarios.map(({ title, work }) =>
              Effect.gen(function* measureScenario() {
                const run = attempt(async () => {
                  await runtime.runPromise(work);
                });
                yield* Effect.all(Array.from({ length: WARMUP_RUNS }, () => run));
                const delay = monitorEventLoopDelay({ resolution: 1 });
                const durations = yield* Effect.all(
                  Array.from({ length: MEASURED_RUNS }, () =>
                    Effect.gen(function* measureRun() {
                      delay.enable();
                      yield* Effect.sleep(SETTLE_MILLISECONDS);
                      const started = performance.now();
                      yield* run;
                      const elapsed = performance.now() - started;
                      yield* Effect.sleep(SETTLE_MILLISECONDS);
                      delay.disable();
                      return elapsed;
                    }),
                  ),
                );
                return {
                  blocked: delay.max / NANOSECONDS_PER_MILLISECOND,
                  label,
                  title,
                  typical: median(durations),
                };
              }),
            ),
          ),
        (runtime) =>
          Effect.ignore(
            attempt(async () => {
              await runtime.dispose();
            }),
          ),
      ),
    ),
  );

  const sections = scenarios.map(({ title }) => {
    const rows = measurements.flat().filter((measurement) => measurement.title === title);
    const reference = rows[0]?.typical ?? Number.NaN;
    return [
      `## ${title}`,
      "",
      "| Motore | tempo (ms, mediana) | × | event loop bloccato al massimo (ms) |",
      "| --- | --: | --: | --: |",
      ...rows.map(
        ({ blocked, label, typical }) =>
          `| ${label} | ${formatNumber(typical, 1)} | ${formatNumber(reference / typical, 1)}× | ${formatNumber(blocked, 1)} |`,
      ),
      "",
    ].join("\n");
  });
  const report = [
    "# Benchmark effect-pdf: pool di worker",
    "",
    `- Node ${process.version} · ${process.platform}/${process.arch} · ${navigator.hardwareConcurrency.toString()} core`,
    `- Mediana di ${MEASURED_RUNS.toString()} esecuzioni dopo ${WARMUP_RUNS.toString()} di riscaldamento. La colonna × è la velocità rispetto al motore in-process.`,
    "- «Event loop bloccato» è il ritardo più lungo misurato sul thread principale durante il lavoro: con il motore in-process il server non risponde ad altre richieste per tutto quel tempo.",
    "",
    ...sections,
  ].join("\n");
  const results = yield* path.fromFileUrl(new URL("results/", import.meta.url));
  yield* fs.makeDirectory(results, { recursive: true });
  yield* fs.writeFileString(path.join(results, "pool.md"), report);
  yield* Console.log(report);
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
