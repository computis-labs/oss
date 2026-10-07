import "effect/schema/SchemaJITCompiler/enable";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { parse as parseEksml } from "@eksml/xml/parser";
import { Console, Effect, FileSystem, Path, Schema } from "effect";
import { Bench } from "tinybench";
import { parse as parseTxml } from "txml/txml";
import { makeBaseline } from "./baseline.ts";
import { makeFixtures } from "./fixtures.ts";
// oxlint-disable-next-line test-boundary/no-test-imports -- the benchmarks are removed before the merge and share the test invoices until then
import { FatturaXml } from "../tests/fixtures/fattura.ts";
import { makeWriter } from "../src/encoder.ts";
import { codec } from "../src/index.ts";
import { tokenize } from "../src/tokenizer.ts";
import * as Xsd from "../src/xsd.ts";

const XSD_DIRECTORY = "../tests/fixtures/xsd/";
const STRING_SUBCLASS_FLAG = "--string-subclass";

const phases = {
  decode: {
    reference: "attuale (fast-xml-parser + Schema)",
    title: "Decode: XML → fattura tipizzata",
  },
  encode: {
    reference: "attuale (Schema + fast-xml-builder)",
    title: "Encode: fattura tipizzata → XML",
  },
  tokenize: { reference: "fast-xml-parser", title: "Parsing XML (senza Schema)" },
  validate: { reference: "xmllint-wasm", title: "Validazione XSD" },
  writer: { reference: "fast-xml-builder", title: "Scrittura XML (senza Schema)" },
} as const;

type Phase = keyof typeof phases;

const noop = () => true;
const noopHandler = { attribute: noop, close: noop, openEnd: noop, openStart: noop, text: noop };

const formatNumber = (value: number, digits: number) =>
  value.toLocaleString("it-IT", { maximumFractionDigits: digits, minimumFractionDigits: digits });

const program = Effect.gen(function* effectXmlBenchmark() {
  const stringSubclass = process.argv.includes(STRING_SUBCLASS_FLAG);
  if (stringSubclass) {
    Reflect.defineProperty(globalThis, "BenchString", { value: class extends String {} });
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* path.fromFileUrl(new URL(XSD_DIRECTORY, import.meta.url));
  const mainPath = path.join(directory, "Schema_VFPR12_v1.2.3.xsd");
  const dsigPath = path.join(directory, "xmldsig-core-schema.xsd");
  const baseline = makeBaseline({
    dsig: { contents: yield* fs.readFileString(dsigPath), fileName: "xmldsig-core-schema.xsd" },
    main: { contents: yield* fs.readFileString(mainPath), fileName: "Schema_VFPR12_v1.2.3.xsd" },
  });
  const fixtures = makeFixtures(baseline);
  const xml = yield* Effect.fromResult(codec(FatturaXml));
  const decodeEncodedFattura = Schema.decodeUnknownEffect(FatturaXml);
  const write = makeWriter(xml.plan);
  const validator = yield* Xsd.make({ schema: { path: mainPath } });
  const encodeFattura = Schema.encodeSync(FatturaXml);

  for (const fixture of fixtures) {
    const decoded = yield* xml.decode(fixture.xml);
    const encoded = yield* xml.encode(fixture.fattura);
    yield* validator.validate(encoded);
    if (JSON.stringify(encodeFattura(decoded)) !== JSON.stringify(encodeFattura(fixture.fattura))) {
      yield* Effect.die(`decode diverso per ${fixture.name}`);
    }
  }

  const rows: {
    readonly fixture: string;
    readonly implementation: string;
    readonly kb: number;
    readonly meanMs: number;
    readonly opsPerSecond: number;
    readonly p99Ms: number;
    readonly phase: Phase;
  }[] = [];

  for (const fixture of fixtures) {
    yield* Console.log(`▶ ${fixture.name} (${formatNumber(fixture.bytes / 1024, 1)} KB)`);
    const encoded = baseline.encodeFattura(fixture.fattura);
    const tasks: readonly (readonly [Phase, string, () => void | Promise<void>])[] = [
      [
        "tokenize",
        phases.tokenize.reference,
        () => {
          baseline.parser.parse(fixture.xml);
        },
      ],
      [
        "tokenize",
        "txml",
        () => {
          parseTxml(fixture.xml);
        },
      ],
      [
        "tokenize",
        "eksml",
        () => {
          parseEksml(fixture.xml);
        },
      ],
      [
        "tokenize",
        "effect-xml tokenize",
        () => {
          tokenize(fixture.xml, noopHandler);
        },
      ],
      [
        "decode",
        phases.decode.reference,
        () => {
          baseline.decodeFatturaFromXmlSync(fixture.xml);
        },
      ],
      [
        "decode",
        "solo Schema della pipeline attuale (union con wrapper, su output di fast-xml-parser)",
        () => {
          fixture.schemaDecode();
        },
      ],
      [
        "decode",
        "solo Schema di effect-xml (Schema generato dallo XSD, su oggetto encoded)",
        () => {
          Effect.runSync(decodeEncodedFattura(encoded));
        },
      ],
      [
        "decode",
        "effect-xml",
        () => {
          Effect.runSync(xml.decode(fixture.xml));
        },
      ],
      [
        "encode",
        phases.encode.reference,
        () => {
          baseline.encodeFatturaToXml(fixture.fattura);
        },
      ],
      [
        "encode",
        "effect-xml",
        () => {
          Effect.runSync(xml.encode(fixture.fattura));
        },
      ],
      [
        "writer",
        phases.writer.reference,
        () => {
          baseline.buildDocument("compact", encoded);
        },
      ],
      [
        "writer",
        "effect-xml writer",
        () => {
          write(encoded);
        },
      ],
      [
        "validate",
        phases.validate.reference,
        async () => {
          await baseline.validateInvoiceXml(fixture.xml);
        },
      ],
      [
        "validate",
        "effect-xml (libxml2-wasm)",
        () => {
          Effect.runSync(validator.validate(fixture.xml));
        },
      ],
    ];
    const bench = new Bench({ name: fixture.name, time: 1000, warmupTime: 300 });
    const labels = new Map<string, readonly [Phase, string]>();
    for (const [phase, implementation, run] of tasks) {
      const name = `${phase} · ${implementation}`;
      labels.set(name, [phase, implementation]);
      bench.add(name, run);
    }
    yield* Effect.promise(async () => await bench.run());
    for (const task of bench.tasks) {
      const label = labels.get(task.name);
      if (task.result.state === "completed" && label !== undefined) {
        rows.push({
          fixture: fixture.name,
          implementation: label[1],
          kb: fixture.bytes / 1024,
          meanMs: task.result.latency.mean,
          opsPerSecond: task.result.throughput.mean,
          p99Ms: task.result.latency.p99,
          phase: label[0],
        });
      }
    }
  }

  const sections = Object.entries(phases).flatMap(([phase, { reference, title }]) => [
    `## ${title}`,
    "",
    `Riferimento: ${reference}. La colonna × è la velocità rispetto al riferimento, sulla stessa fixture.`,
    "",
    "| Fixture | KB | Implementazione | media (ms) | p99 (ms) | ops/s | × |",
    "|---|---:|---|---:|---:|---:|---:|",
    ...rows
      .filter((row) => row.phase === phase)
      .map((row) => {
        const base = rows.find(
          (candidate) =>
            candidate.phase === row.phase &&
            candidate.fixture === row.fixture &&
            candidate.implementation === reference,
        );
        const speedup = base === undefined ? "" : `${formatNumber(base.meanMs / row.meanMs, 2)}×`;
        return `| ${row.fixture} | ${formatNumber(row.kb, 1)} | ${row.implementation} | ${formatNumber(row.meanMs, 3)} | ${formatNumber(row.p99Ms, 3)} | ${formatNumber(row.opsPerSecond, 0)} | ${speedup} |`;
      }),
    "",
  ]);

  const report = [
    `# Benchmark effect-xml${stringSubclass ? " (con sottoclasse di String, come nel backend)" : ""}`,
    "",
    `- Node ${process.version} · ${process.platform}/${process.arch} · ${String(navigator.hardwareConcurrency)} core`,
    "- Riferimento: pipeline fast-xml-parser + Schema, in `bench/baseline.ts`",
    "- Fixture: `tests/fixtures/fattura.ts`, XML indentato; ogni fixture è verificata prima delle misure (decode, encode e XSD)",
    "- Effect rc.116 con Schema JIT attivo per tutto il processo, come nel backend: vale sia per la pipeline attuale sia per effect-xml",
    "",
    ...sections,
  ].join("\n");

  const output = yield* path.fromFileUrl(
    new URL(`results/benchmark${stringSubclass ? "-string-subclass" : ""}.md`, import.meta.url),
  );
  yield* fs.makeDirectory(path.dirname(output), { recursive: true });
  yield* fs.writeFileString(output, report);
  yield* Console.log(report);
});

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
