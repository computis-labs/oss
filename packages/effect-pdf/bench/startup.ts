import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, FileSystem, ManagedRuntime, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { bilevelScanPdf } from "./fixtures.ts";
import { attempt, formatNumber, median } from "./support.ts";
import { PdfEngine } from "../src/engine.ts";
import { open } from "../src/index.ts";

const SIZES = [1, 2, 4] as const;
const RUNS = 3;
const BYTES_PER_MEGABYTE = 2 ** 20;
const MEASURE_FLAG = "--measure";

const Measurement = Schema.Struct({ readyMs: Schema.Finite, rssMb: Schema.Finite });
const decodeMeasurement = Schema.decodeUnknownEffect(Schema.fromJsonString(Measurement));

const measureOnce = Effect.gen(function* measurePoolStartup() {
  const size = Number(process.argv[process.argv.indexOf(MEASURE_FLAG) + 1]);
  const pdf = yield* attempt(async () => await bilevelScanPdf(1));
  const started = performance.now();
  const runtime = ManagedRuntime.make(PdfEngine.layer({ size }));
  yield* attempt(
    async () =>
      await runtime.runPromise(
        Effect.all(
          Array.from({ length: size }, () =>
            Effect.scoped(Effect.flatMap(open(pdf), (document) => document.classify)),
          ),
          { concurrency: "unbounded" },
        ),
      ),
  );
  const readyMs = performance.now() - started;
  const rssMb = process.memoryUsage().rss / BYTES_PER_MEGABYTE;
  yield* attempt(async () => {
    await runtime.dispose();
  });
  yield* Console.log(JSON.stringify({ readyMs, rssMb }));
});

const compare = Effect.gen(function* comparePoolSizes() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const script = import.meta.filename;
  const rows = yield* Effect.all(
    SIZES.map((size) =>
      Effect.gen(function* measureSize() {
        const runs = yield* Effect.all(
          Array.from({ length: RUNS }, () =>
            Effect.gen(function* measureInChildProcess() {
              const output = yield* spawner.string(
                ChildProcess.make(process.execPath, [script, MEASURE_FLAG, size.toString()]),
              );
              return yield* decodeMeasurement(output.trim());
            }),
          ),
        );
        return `| ${size.toString()} | ${formatNumber(median(runs.map(({ readyMs }) => readyMs)), 0)} | ${formatNumber(median(runs.map(({ rssMb }) => rssMb)), 0)} |`;
      }),
    ),
  );
  const report = [
    "# Benchmark effect-pdf: avvio e memoria del pool",
    "",
    `- Node ${process.version} · ${process.platform}/${process.arch}`,
    `- Ogni riga è la mediana di ${RUNS.toString()} processi separati: dall'avvio del pool alla prima classificazione completata su ogni worker, e la memoria residente (RSS) dell'intero processo in quel momento.`,
    "- Il binario di PDFium è compilato una volta nel thread principale e condiviso con i worker; i moduli che girano nei worker importano solo i moduli di Effect che usano.",
    "",
    "| Worker | pronto dopo (ms) | RSS del processo (MB) |",
    "| --: | --: | --: |",
    ...rows,
    "",
  ].join("\n");
  const results = yield* path.fromFileUrl(new URL("results/", import.meta.url));
  yield* fs.makeDirectory(results, { recursive: true });
  yield* fs.writeFileString(path.join(results, "startup.md"), report);
  yield* Console.log(report);
});

NodeRuntime.runMain(
  Effect.gen(function* runStartupBenchmark() {
    if (process.argv.includes(MEASURE_FLAG)) {
      return yield* measureOnce;
    }
    return yield* compare;
  }).pipe(Effect.provide(NodeServices.layer)),
);
