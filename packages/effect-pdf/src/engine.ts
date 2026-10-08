import { NodeServices, NodeWorker } from "@effect/platform-node";
import { availableParallelism } from "node:os";
import { Worker as WorkerThread } from "node:worker_threads";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Schema,
  Scope,
  SynchronizedRef,
} from "effect";
import { RpcClient, RpcClientError, RpcTest, RpcWorker } from "effect/rpc";
import type { RpcGroup } from "effect/rpc";
import { Worker } from "effect/workers";
import { PdfEngineError } from "#effect-pdf/errors/pdf-engine-error";
import { PdfWorkerGone } from "#effect-pdf/errors/pdf-worker-gone";
import { PdfiumRuntime } from "#effect-pdf/pdfium";
import { PdfiumWasm, PdfWorkerInit } from "#effect-pdf/pdfium-wasm";
import { PdfRpcs } from "#effect-pdf/rpc";
import { PdfRpcHandlers } from "#effect-pdf/server";

const MAX_DEFAULT_WORKERS = 4;

export const pdfWorkerEntry = new URL("worker.ts", import.meta.url);

export type PdfRpcClient = RpcClient.RpcClient<
  RpcGroup.Rpcs<typeof PdfRpcs>,
  RpcClientError.RpcClientError
>;

export interface PdfWorkerLease {
  readonly document: number;
  readonly generation: number;
  readonly worker: number;
}

interface Connection {
  readonly client: PdfRpcClient;
  readonly died: Deferred.Deferred<number>;
  readonly generation: number;
  readonly scope: Scope.Closeable;
}

const isWorkerGone = Schema.is(PdfWorkerGone);
const isRpcClientError = Schema.is(RpcClientError.RpcClientError);
const isWorkerThread = Schema.is(Schema.instanceOf(WorkerThread));

const UNKNOWN_EXIT_CODE = -1;

const workerFailure = (cause: unknown) =>
  new PdfEngineError({ cause, message: "The PDF worker failed: open the document again." });

const makePool = Effect.fn("PdfEngine.makePool")(function* makePool<R>(
  size: number,
  connect: (scope: Scope.Scope) => Effect.Effect<PdfRpcClient, unknown, R>,
) {
  const services = yield* Effect.context<R>();
  const poolScope = yield* Effect.scope;
  const connectionsScope = yield* Scope.fork(poolScope);
  const shuttingDown = yield* Ref.make(false);
  yield* Effect.addFinalizer(() => Ref.set(shuttingDown, true));
  const nextDocument = yield* Ref.make(0);

  const open = Effect.fn("PdfEngine.openConnection")(function* openConnection(generation: number) {
    const scope = yield* Scope.fork(connectionsScope);
    const died = yield* Deferred.make<number>();
    const spawner = Context.getOption(services, Worker.Spawner);
    const watched = Option.isSome(spawner)
      ? Context.add(services, Worker.Spawner, (id: number) => {
          const spawned = spawner.value(id);
          if (isWorkerThread(spawned)) {
            spawned.once("exit", (code: number) => {
              Deferred.doneUnsafe(died, Exit.succeed(code));
            });
          }
          return spawned;
        })
      : services;
    const client = yield* connect(scope).pipe(
      Effect.provideContext(watched),
      Effect.mapError(workerFailure),
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
    return { client, died, generation, scope } satisfies Connection;
  });

  const workers = yield* Effect.all(
    Array.from({ length: size }, () => Effect.flatMap(open(0), SynchronizedRef.make)),
  );
  const loads = yield* SynchronizedRef.make<readonly number[]>(workers.map(() => 0));

  const supervise = Effect.fn("PdfEngine.supervise")(function* superviseWorker(
    worker: SynchronizedRef.SynchronizedRef<Connection>,
    connection: Connection,
  ): Effect.fn.Return<void> {
    const replace = Effect.gen(function* replaceDeadWorker() {
      const code = yield* Deferred.await(connection.died);
      yield* SynchronizedRef.updateEffect(worker, (current) =>
        Effect.gen(function* swapConnection() {
          if (current.generation !== connection.generation || (yield* Ref.get(shuttingDown))) {
            return current;
          }
          yield* Effect.logWarning("effectPdf.worker.replaced", { code });
          const next = yield* open(current.generation + 1);
          yield* Scope.close(current.scope, Exit.void);
          yield* supervise(worker, next);
          return next;
        }),
      );
    });
    yield* replace.pipe(
      Effect.tapError((failure) =>
        Effect.logWarning("effectPdf.worker.replaceFailed", { reason: failure.message }),
      ),
      Effect.ignore,
      Effect.forkIn(poolScope),
    );
  });

  yield* Effect.forEach(
    workers,
    (worker) =>
      Effect.flatMap(SynchronizedRef.get(worker), (connection) => supervise(worker, connection)),
    { discard: true },
  );

  const attempt = Effect.fn("PdfEngine.attempt")(function* attemptOnWorker<A, E>(
    lease: PdfWorkerLease,
    request: (
      client: PdfRpcClient,
      document: number,
    ) => Effect.Effect<A, E | RpcClientError.RpcClientError>,
  ) {
    const worker = workers[lease.worker];
    const connection = worker === undefined ? undefined : yield* SynchronizedRef.get(worker);
    if (worker === undefined || connection?.generation !== lease.generation) {
      return yield* new PdfEngineError({
        message: "The PDF worker restarted after a failure: open the document again.",
      });
    }
    const gone = (cause: unknown) =>
      Effect.andThen(
        Deferred.succeed(connection.died, UNKNOWN_EXIT_CODE),
        Effect.fail(new PdfWorkerGone({ cause })),
      );
    return yield* request(connection.client, lease.document).pipe(
      Effect.raceFirst(
        Effect.flatMap(Deferred.await(connection.died), (code) =>
          gone(`The PDF worker exited with code ${code.toString()}.`),
        ),
      ),
      Effect.catchIf(
        isRpcClientError,
        (error): Effect.Effect<never, PdfEngineError | PdfWorkerGone> =>
          error.reason instanceof RpcClientError.RpcClientDefect
            ? Effect.fail(workerFailure(error))
            : gone(error),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.fail(new PdfWorkerGone({ cause: "The PDF worker connection closed." }))
          : Effect.failCause(cause),
      ),
    );
  });

  const call = Effect.fn("PdfEngine.call")(function* callWorker<A, E>(
    lease: PdfWorkerLease,
    request: (
      client: PdfRpcClient,
      document: number,
    ) => Effect.Effect<A, E | RpcClientError.RpcClientError>,
  ) {
    return yield* attempt(lease, request).pipe(
      Effect.catchIf(isWorkerGone, ({ cause }) => Effect.fail(workerFailure(cause))),
    );
  });

  const reserve = (excluded: ReadonlySet<number>) =>
    SynchronizedRef.modify(loads, (current): [number, readonly number[]] => {
      const [least] = current
        .flatMap((load, index) => (excluded.has(index) ? [] : [{ index, load }]))
        .toSorted((left, right) => left.load - right.load);
      const index = least?.index ?? 0;
      return [index, current.map((load, position) => (position === index ? load + 1 : load))];
    });

  const unreserve = (chosen: number) =>
    SynchronizedRef.update(loads, (current) =>
      current.map((load, position) => (position === chosen ? load - 1 : load)),
    );

  return {
    call,
    lease: Effect.fn("PdfEngine.lease")(function* leaseWorker<A, E>(
      excluded: ReadonlySet<number>,
      start: (
        client: PdfRpcClient,
        document: number,
      ) => Effect.Effect<A, E | RpcClientError.RpcClientError>,
    ) {
      const documentScope = yield* Effect.scope;
      const document = yield* Ref.getAndUpdate(nextDocument, (id) => id + 1);
      const startOnLeastLoaded = Effect.gen(function* startOnWorker() {
        const attemptScope = yield* Scope.fork(documentScope);
        return yield* Effect.gen(function* openOnChosenWorker() {
          const chosen = yield* Effect.acquireRelease(reserve(excluded), unreserve);
          const worker = workers[chosen];
          if (worker === undefined) {
            return yield* new PdfEngineError({ message: "The PDF worker pool is empty." });
          }
          const lease: PdfWorkerLease = {
            document,
            generation: (yield* SynchronizedRef.get(worker)).generation,
            worker: chosen,
          };
          yield* Effect.addFinalizer(() =>
            Effect.ignore(call(lease, (client, id) => client.Close({ document: id }))),
          );
          return { lease, value: yield* attempt(lease, start) };
        }).pipe(
          Scope.provide(attemptScope),
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) ? Effect.void : Scope.close(attemptScope, exit),
          ),
        );
      });
      return yield* startOnLeastLoaded.pipe(
        Effect.retry({ times: 1, while: isWorkerGone }),
        Effect.catchIf(isWorkerGone, ({ cause }) => Effect.fail(workerFailure(cause))),
      );
    }),
    size,
  } as const;
});

const connectToWorker = Effect.fn("PdfEngine.connectToWorker")(function* connectToWorker(
  scope: Scope.Scope,
) {
  const protocol = yield* RpcClient.makeProtocolWorker({ size: 1 }).pipe(Scope.provide(scope));
  return yield* RpcClient.make(PdfRpcs).pipe(
    Effect.provideService(RpcClient.Protocol, protocol),
    Scope.provide(scope),
  );
});

export class PdfEngine extends Context.Service<
  PdfEngine,
  Effect.Success<ReturnType<typeof makePool>>
>()("@computis/effect-pdf/engine/PdfEngine") {
  static readonly layerWorkers = ({
    size = Math.max(1, Math.min(MAX_DEFAULT_WORKERS, availableParallelism() - 1)),
  }: { readonly size?: number } = {}) =>
    Layer.effect(PdfEngine, makePool(Math.max(1, Math.floor(size)), connectToWorker)).pipe(
      Layer.provide(
        RpcWorker.layerInitialMessage(
          PdfWorkerInit,
          Effect.gen(function* sharedPdfium() {
            const { module } = yield* PdfiumWasm;
            return { wasm: module };
          }),
        ),
      ),
      Layer.provide(PdfiumWasm.layerCompiled),
      Layer.provide(NodeServices.layer),
    );

  static readonly layer = (options: { readonly size?: number } = {}) =>
    PdfEngine.layerWorkers(options).pipe(
      Layer.provide(NodeWorker.layer(() => new WorkerThread(pdfWorkerEntry))),
    );

  static readonly layerInProcess = Layer.effect(
    PdfEngine,
    makePool(1, (scope) => RpcTest.makeClient(PdfRpcs).pipe(Scope.provide(scope))),
  ).pipe(
    Layer.provide(PdfRpcHandlers),
    Layer.provide(PdfiumRuntime.layer),
    Layer.provide(PdfiumWasm.layerCompiled),
    Layer.provide(NodeServices.layer),
  );
}
