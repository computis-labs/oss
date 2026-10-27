import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { Worker } from "node:worker_threads";
import { PdfEngine, pdfWorkerEntry } from "../src/engine.ts";
import type { PdfPool } from "../src/engine.ts";
import { openDocument } from "../src/document.ts";
import { PdfEngineError } from "../src/errors/pdf-engine-error.ts";
import { open } from "../src/index.ts";
import { textPdf } from "./fixtures/forms.ts";
import { nodeWorkers } from "./fixtures/layer.ts";

const failingWorkers = (
  failures: ReadonlySet<number>,
  size = 1,
  entry = new URL("fixtures/crash-on-open.ts", import.meta.url),
) => {
  const counters = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));

  return {
    failedOpens: () => Atomics.load(counters, 0),
    layer: PdfEngine.layer({ size }).pipe(
      Layer.provide(
        nodeWorkers(() => {
          const index = Atomics.add(counters, 1, 1);

          return new Worker(failures.has(index) ? entry : pdfWorkerEntry, {
            workerData: counters.buffer,
          });
        }),
      ),
      Layer.provide(NodeServices.layer),
    ),
    spawned: () => Atomics.load(counters, 1),
  };
};

it.effect("retries an open with intact PDF bytes after the receiving worker exits", () => {
  const workers = failingWorkers(new Set([0]));

  return Effect.gen(function* () {
    const bytes = yield* textPdf([["The retry keeps this text"]]);
    const original = new Uint8Array(bytes);

    const document = yield* open(bytes);
    const [page] = yield* document.text();

    expect(page?.text).toContain("The retry keeps this text");
    expect(bytes).toStrictEqual(original);
    expect(workers.failedOpens()).toBe(1);
    expect(workers.spawned()).toBe(2);
  }).pipe(Effect.provide(workers.layer));
});

it.effect("retries opening a replica without losing the retained PDF bytes", () => {
  const workers = failingWorkers(new Set([1]), 2);

  return Effect.gen(function* () {
    const bytes = yield* textPdf(
      Array.from({ length: 12 }, (_, page) => [`Retry page ${page.toString()}`]),
    );

    const original = new Uint8Array(bytes);
    const engine = yield* PdfEngine;
    const used: number[] = [];

    const pool: PdfPool = {
      ...engine,
      call: (lease, request) => {
        used.push(lease.worker);

        return engine.call(lease, request);
      },
    };

    const document = yield* openDocument(pool)(bytes);

    const pages = yield* document.text();
    expect(new Set(used)).toStrictEqual(new Set([0, 1]));
    const again = yield* document.text({ pages: [11, 0, 9, 1, 8, 2, 7, 3] });

    expect(pages.map(({ page }) => page)).toStrictEqual(
      Array.from({ length: 12 }, (_, page) => page),
    );
    expect(pages.every(({ page, text }) => text.includes(`Retry page ${page.toString()}`))).toBe(
      true,
    );
    expect(again.map(({ page }) => page)).toStrictEqual([11, 0, 9, 1, 8, 2, 7, 3]);
    expect(bytes).toStrictEqual(original);
    expect(workers.failedOpens()).toBe(1);
    expect(workers.spawned()).toBe(3);
  }).pipe(Effect.provide(workers.layer));
});

it.effect("stops after one retry and keeps the pool usable for another document", () => {
  const workers = failingWorkers(new Set([0, 1]));

  return Effect.gen(function* () {
    const bytes = yield* textPdf([["A later document still opens"]]);
    const original = new Uint8Array(bytes);

    const failure = yield* Effect.flip(open(bytes));
    expect(failure).toBeInstanceOf(PdfEngineError);
    expect(workers.failedOpens()).toBe(2);

    const document = yield* open(bytes);
    const [page] = yield* document.text();
    expect(page?.text).toContain("A later document still opens");
    expect(bytes).toStrictEqual(original);
    expect(workers.spawned()).toBe(3);
  }).pipe(Effect.provide(workers.layer));
});

it.effect("replaces a connection interrupted by the worker before retrying the open", () => {
  const workers = failingWorkers(
    new Set([0]),
    1,
    new URL("fixtures/interrupt-on-open.ts", import.meta.url),
  );

  return Effect.gen(function* () {
    const bytes = yield* textPdf([["The interrupted open recovers"]]);
    const original = new Uint8Array(bytes);

    const document = yield* open(bytes);
    const [page] = yield* document.text();

    expect(page?.text).toContain("The interrupted open recovers");
    expect(bytes).toStrictEqual(original);
    expect(workers.failedOpens()).toBe(1);
    expect(workers.spawned()).toBe(2);
  }).pipe(Effect.provide(workers.layer));
});

it.effect("stops after two interrupted opens and keeps the pool usable", () => {
  const workers = failingWorkers(
    new Set([0, 1]),
    1,
    new URL("fixtures/interrupt-on-open.ts", import.meta.url),
  );

  return Effect.gen(function* () {
    const bytes = yield* textPdf([["The next open still works"]]);
    const original = new Uint8Array(bytes);

    const failure = yield* Effect.flip(open(bytes));
    expect(failure).toBeInstanceOf(PdfEngineError);
    expect(workers.failedOpens()).toBe(2);

    const document = yield* open(bytes);
    const [page] = yield* document.text();
    expect(page?.text).toContain("The next open still works");
    expect(bytes).toStrictEqual(original);
    expect(workers.spawned()).toBe(3);
  }).pipe(Effect.provide(workers.layer));
});

it.effect("allows a pending lease to be interrupted without replacing its healthy worker", () => {
  const workers = failingWorkers(new Set());

  return Effect.gen(function* () {
    const engine = yield* PdfEngine;
    const started = yield* Deferred.make<boolean>();

    const pending = yield* engine
      .lease(new Set(), () => Deferred.succeed(started, true).pipe(Effect.andThen(Effect.never)))
      .pipe(Effect.forkChild);

    yield* Deferred.await(started);
    yield* Fiber.interrupt(pending);

    const document = yield* open(yield* textPdf([["The worker is still usable"]]));
    const [page] = yield* document.text();
    expect(page?.text).toContain("The worker is still usable");
    expect(workers.spawned()).toBe(1);
    expect(workers.failedOpens()).toBe(0);
  }).pipe(Effect.provide(workers.layer));
});
