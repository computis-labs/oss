import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, FileSystem, Layer, Path } from "effect";
import { encode } from "fast-png";
import { Bench } from "tinybench";
import { makeBaseline } from "./baseline.ts";
import { BenchmarkError, attempt, formatNumber, nodePdfEngine } from "./support.ts";
import { bilevelScanPdf, invoicePdf, jpegScanPdf } from "./fixtures.ts";
import type { PdfEngine } from "../src/engine.ts";
import { open } from "../src/index.ts";
import { encodePng, pngScanlines } from "../src/png.ts";
import type { Raster } from "../src/png.ts";
import { pdfPageKinds } from "../src/types.ts";
import type { PdfDocument } from "../src/types.ts";

const RENDER_WIDTH = 900;
const PDFJS = "pdf.js (pipeline attuale)";
const EFFECT_PDF = "effect-pdf";
const picturedKinds: ReadonlySet<string> = new Set([pdfPageKinds.image, pdfPageKinds.mixed]);

const picturedImages = (document: PdfDocument) =>
  Effect.gen(function* picturedPageImages() {
    const { pages } = yield* document.classify;
    const pictured = pages.flatMap(({ kind }, index) => (picturedKinds.has(kind) ? [index] : []));
    return yield* document.pageImages({ pages: pictured });
  });

const documentRaster = (width: number, height: number, bitDepth: 1 | 8): Raster => {
  const channels = bitDepth === 1 ? 1 : 3;
  const rowBytes = bitDepth === 1 ? Math.ceil(width / 8) : width * channels;
  const data = Uint8Array.from({ length: rowBytes * height }, (_, index) =>
    Math.floor(index / rowBytes) % 40 < 14 && (index % rowBytes) % 9 < 6 ? 0x81 : 0xff,
  );
  return { bitDepth, channels, data, height, rowBytes, width };
};

const pdf = (label: string, bytes: Uint8Array) => ({
  bytes,
  kilobytes: bytes.length / 1024,
  label,
});

const onBaseline = (effect: Effect.Effect<unknown, BenchmarkError>) => async () => {
  await Effect.runPromise(effect);
};

const program = Effect.gen(function* effectPdfBenchmark() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const services = yield* Effect.context<PdfEngine>();
  const baseline = yield* makeBaseline;
  const onDocument =
    <A, E>(bytes: Uint8Array, work: (document: PdfDocument) => Effect.Effect<A, E>) =>
    async () => {
      await Effect.runPromiseWith(services)(Effect.scoped(Effect.flatMap(open(bytes), work)));
    };
  const jpeg = yield* fs.readFile(
    yield* path.fromFileUrl(new URL("../tests/fixtures/scan.jpg", import.meta.url)),
  );
  const [invoice1, invoice8, scan1, scan5, jpegScan] = yield* attempt(
    async () =>
      await Promise.all([
        invoicePdf(20),
        invoicePdf(380),
        bilevelScanPdf(1),
        bilevelScanPdf(5),
        jpegScanPdf(jpeg),
      ]),
  );
  const rasters = [
    { label: "render RGB 900×1273", raster: documentRaster(900, 1273, 8) },
    { label: "scansione 1 bit 1654×2339", raster: documentRaster(1654, 2339, 1) },
  ];

  const sections: readonly {
    readonly candidateName: string;
    readonly comparisons: readonly {
      readonly candidate: () => Promise<void>;
      readonly kilobytes: number;
      readonly label: string;
      readonly reference: () => Promise<void>;
    }[];
    readonly note?: string;
    readonly referenceName: string;
    readonly title: string;
  }[] = [
    {
      candidateName: EFFECT_PDF,
      comparisons: [pdf("1 pagina", invoice1), pdf("8 pagine", invoice8)].map(
        ({ bytes, kilobytes, label }) => ({
          candidate: onDocument(bytes, (document) =>
            Effect.andThen(document.classify, document.text()),
          ),
          kilobytes,
          label,
          reference: onBaseline(baseline.importText(bytes)),
        }),
      ),
      referenceName: PDFJS,
      title: "Import fattura da PDF testuale: classificazione + testo",
    },
    {
      candidateName: EFFECT_PDF,
      comparisons: [pdf("1 pagina A4 a 200 dpi", scan1), pdf("5 pagine A4 a 200 dpi", scan5)].map(
        ({ bytes, kilobytes, label }) => ({
          candidate: onDocument(bytes, picturedImages),
          kilobytes,
          label,
          reference: onBaseline(baseline.importScan(bytes)),
        }),
      ),
      note: "PDFium decodifica un'immagine a 1 bit espandendola a 8 bit per pixel, ed effect-pdf la reimpacchetta a 1 bit prima del PNG; pdf.js la decodifica direttamente a 1 bit. Per questo qui effect-pdf è più lento, mentre classificazione e testo della stessa pagina sono molto più veloci.",
      referenceName: PDFJS,
      title: "Import fattura da scansione 1-bit: classificazione + immagini per il modello (PNG)",
    },
    {
      candidateName: EFFECT_PDF,
      comparisons: [pdf("1 pagina", jpegScan)].map(({ bytes, kilobytes, label }) => ({
        candidate: onDocument(bytes, picturedImages),
        kilobytes,
        label,
        reference: onBaseline(baseline.importScan(bytes)),
      })),
      referenceName: PDFJS,
      title: "Import fattura da scansione JPEG: classificazione + immagini per il modello",
    },
    {
      candidateName: EFFECT_PDF,
      comparisons: [pdf("fattura, 1 pagina", invoice1), pdf("scansione 1-bit", scan1)].map(
        ({ bytes, kilobytes, label }) => ({
          candidate: onDocument(bytes, (document) => document.render(0, { width: RENDER_WIDTH })),
          kilobytes,
          label,
          reference: onBaseline(baseline.render(bytes, RENDER_WIDTH)),
        }),
      ),
      referenceName: PDFJS,
      title: `Render della pagina 1 a ${RENDER_WIDTH.toString()} px (PNG)`,
    },
    {
      candidateName: "encodePng (CompressionStream)",
      comparisons: rasters.map(({ label, raster }) => ({
        candidate: async () => {
          await Effect.runPromise(encodePng(pngScanlines(raster)));
        },
        kilobytes: raster.data.length / 1024,
        label,
        reference: async () => {
          await Promise.resolve(
            encode({
              channels: raster.channels,
              data: raster.data,
              depth: raster.bitDepth,
              height: raster.height,
              width: raster.width,
            }),
          );
        },
      })),
      note: "Motivo di `src/png.ts` invece di fast-png: `CompressionStream` usa lo zlib nativo della piattaforma, che comprime più in fretta del deflate in JavaScript di fast-png.",
      referenceName: "fast-png",
      title: "Codifica PNG di un raster già decodificato",
    },
  ];

  const measured = yield* Effect.all(
    sections.map(({ candidateName, comparisons, note, referenceName, title }) =>
      Effect.gen(function* measureSection() {
        const rows = yield* Effect.all(
          comparisons.map(({ candidate, kilobytes, label, reference }) =>
            Effect.gen(function* measureComparison() {
              const bench = new Bench({ time: 1500, warmupTime: 300 });
              bench.add(referenceName, reference);
              bench.add(candidateName, candidate);
              yield* attempt(async () => {
                await bench.run();
              });
              const latencies = bench.tasks.flatMap((task) =>
                task.result.state === "completed"
                  ? [{ latency: task.result.latency, name: task.name }]
                  : [],
              );
              const failed = bench.tasks.find((task) => task.result.state !== "completed");
              if (failed !== undefined) {
                return yield* new BenchmarkError({ cause: failed.result });
              }
              const referenceMean = latencies[0]?.latency.mean ?? Number.NaN;
              return latencies.map(
                ({ latency, name }) =>
                  `| ${label} | ${formatNumber(kilobytes, 1)} | ${name} | ${formatNumber(latency.mean, 2)} | ${formatNumber(latency.p99, 2)} | ${formatNumber(referenceMean / latency.mean, 1)}× |`,
              );
            }),
          ),
        );
        return [
          `## ${title}`,
          "",
          `Riferimento: ${referenceName}. La colonna × è la velocità rispetto al riferimento, sulla stessa fixture.`,
          ...(note === undefined ? [] : ["", note]),
          "",
          "| Fixture | KB | Implementazione | media (ms) | p99 (ms) | × |",
          "| --- | --: | --- | --: | --: | --: |",
          ...rows.flat(),
          "",
        ].join("\n");
      }),
    ),
  );
  const report = [
    "# Benchmark effect-pdf",
    "",
    `- Node ${process.version} · ${process.platform}/${process.arch}`,
    "- Riferimento: la pipeline di `apps/backend/src/modules/invoice-translation` su pdf.js (unpdf), replicata in `bench/baseline.ts`: apre il PDF una volta per la classificazione e una per il testo o le immagini",
    "- effect-pdf apre il PDF una volta sola; le fixture sono generate in `bench/fixtures.ts`",
    "",
    ...measured,
  ].join("\n");
  const results = yield* path.fromFileUrl(new URL("results/", import.meta.url));
  yield* fs.makeDirectory(results, { recursive: true });
  yield* fs.writeFileString(path.join(results, "benchmark.md"), report);
  yield* Console.log(report);
});

NodeRuntime.runMain(program.pipe(Effect.provide(Layer.merge(nodePdfEngine(), NodeServices.layer))));
