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

const crashingWorkers = (crashes: ReadonlySet<number>, size = 1) => {
  let spawned = 0;
  const received = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  return {
    crashedOpens: () => Atomics.load(received, 0),
    spawned: () => spawned,
    layer: PdfEngine.layer({ size }).pipe(
      Layer.provide(
        nodeWorkers(
          () =>
            new Worker(
              crashes.has(spawned++)
                ? new URL("./fixtures/crash-on-open.ts", import.meta.url)
                : pdfWorkerEntry,
              { workerData: received.buffer },
            ),
        ),
      ),
      Layer.provide(NodeServices.layer),
    ),
  };
};

it.effect("retries an open with intact PDF bytes after the receiving worker exits", () => {
  const workers = crashingWorkers(new Set([0]));
  return Effect.gen(function* () {
    const bytes = yield* textPdf([["The retry keeps this text"]]);
    const original = new Uint8Array(bytes);

    const document = yield* open(bytes);
    const [page] = yield* document.text();

    expect(page?.text).toContain("The retry keeps this text");
    expect(bytes).toStrictEqual(original);
    expect(workers.crashedOpens()).toBe(1);
    expect(workers.spawned()).toBe(2);
  }).pipe(Effect.provide(workers.layer));
});

it.effect("retries opening a replica without losing the retained PDF bytes", () => {
  const workers = crashingWorkers(new Set([1]), 2);
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
    expect(workers.crashedOpens()).toBe(1);
    expect(workers.spawned()).toBe(3);
  }).pipe(Effect.provide(workers.layer));
});

it.effect("stops after one retry and keeps the pool usable for another document", () => {
  const workers = crashingWorkers(new Set([0, 1]));
  return Effect.gen(function* () {
    const bytes = yield* textPdf([["A later document still opens"]]);
    const original = new Uint8Array(bytes);

    const failure = yield* Effect.flip(open(bytes));
    expect(failure).toBeInstanceOf(PdfEngineError);
    expect(workers.crashedOpens()).toBe(2);

    const document = yield* open(bytes);
    const [page] = yield* document.text();
    expect(page?.text).toContain("A later document still opens");
    expect(bytes).toStrictEqual(original);
    expect(workers.spawned()).toBe(3);
  }).pipe(Effect.provide(workers.layer));
});

it.effect("allows a pending lease to be interrupted without replacing its healthy worker", () => {
  const workers = crashingWorkers(new Set());
  return Effect.gen(function* () {
    const engine = yield* PdfEngine;
    const started = yield* Deferred.make<void>();
    const pending = yield* engine
      .lease(new Set(), () =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      )
      .pipe(Effect.forkChild);

    yield* Deferred.await(started);
    yield* Fiber.interrupt(pending);

    const document = yield* open(yield* textPdf([["The worker is still usable"]]));
    const [page] = yield* document.text();
    expect(page?.text).toContain("The worker is still usable");
    expect(workers.spawned()).toBe(1);
    expect(workers.crashedOpens()).toBe(0);
  }).pipe(Effect.provide(workers.layer));
});
