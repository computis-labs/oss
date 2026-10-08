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
import type { FileSystem, Path } from "effect";
import { RpcClient, RpcClientError, RpcTest, RpcWorker } from "effect/rpc";
import type { RpcGroup } from "effect/rpc";
import { Worker } from "effect/workers";
import { openDocument } from "./document.ts";
import { PdfEngineError } from "./errors/pdf-engine-error.ts";
import { PdfWorkerGone } from "./errors/pdf-worker-gone.ts";
import { PdfiumRuntime } from "./pdfium.ts";
import { PdfiumWasm, PdfWorkerInit } from "./pdfium-wasm.ts";
import { PdfRpcs } from "./rpc.ts";
import { PdfRpcHandlers } from "./server.ts";

const MAX_DEFAULT_WORKERS = 4;
const UNKNOWN_CPUS_WORKERS = 1;

const decodeReportedCpus = Schema.decodeUnknownOption(
  Schema.Struct({
    navigator: Schema.Struct({ hardwareConcurrency: Schema.Int.check(Schema.isGreaterThan(0)) }),
  }),
);

const moduleExtension = import.meta.url.slice(import.meta.url.lastIndexOf("."));

export const pdfWorkerEntry = new URL(`worker${moduleExtension}`, import.meta.url);

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
  readonly died: Deferred.Deferred<unknown>;
  readonly generation: number;
  readonly scope: Scope.Closeable;
}

const isWorkerGone = Schema.is(PdfWorkerGone);
const isRpcClientError = Schema.is(RpcClientError.RpcClientError);

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
    const died = yield* Deferred.make<unknown>();
    const platform = Context.getOption(services, Worker.WorkerPlatform);
    const spawner = Context.getOption(services, Worker.Spawner);
    const watched =
      Option.isSome(platform) && Option.isSome(spawner)
        ? services.pipe(
            Context.add(
              Worker.WorkerPlatform,
              Worker.WorkerPlatform.of({
                spawn: <O, I>(id: number) =>
                  Effect.map(platform.value.spawn<O, I>(id), (worker): Worker.Worker<O, I> => ({
                    run: (handler, options) =>
                      worker
                        .run(
                          (response) => (response === undefined ? Effect.void : handler(response)),
                          options,
                        )
                        .pipe(Effect.tapError((cause) => Deferred.succeed(died, cause))),
                    send: worker.send,
                  })),
              }),
            ),
            Context.add(Worker.Spawner, (id: number) => {
              const spawned = spawner.value(id);
              if (spawned instanceof EventTarget) {
                spawned.addEventListener(
                  "close",
                  () => {
                    Deferred.doneUnsafe(died, Exit.succeed("The PDF worker closed."));
                  },
                  { once: true },
                );
              }
              return spawned;
            }),
          )
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
      const cause = yield* Deferred.await(connection.died);
      yield* SynchronizedRef.updateEffect(worker, (current) =>
        Effect.gen(function* swapConnection() {
          if (current.generation !== connection.generation || (yield* Ref.get(shuttingDown))) {
            return current;
          }
          yield* Effect.logWarning("effectPdf.worker.replaced", { cause });
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
        Deferred.succeed(connection.died, cause),
        Effect.fail(new PdfWorkerGone({ cause })),
      );
    return yield* request(connection.client, lease.document).pipe(
      Effect.raceFirst(Effect.flatMap(Deferred.await(connection.died), gone)),
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

export type PdfPool = Effect.Success<ReturnType<typeof makePool>>;

const withOpen = (pool: PdfPool) => ({ ...pool, open: openDocument(pool) });

export class PdfEngine extends Context.Service<PdfEngine, ReturnType<typeof withOpen>>()(
  "@computis/effect-pdf/engine/PdfEngine",
) {
  static readonly layer = ({
    size = Option.match(decodeReportedCpus(globalThis), {
      onNone: () => UNKNOWN_CPUS_WORKERS,
      onSome: ({ navigator: { hardwareConcurrency } }) =>
        Math.max(1, Math.min(MAX_DEFAULT_WORKERS, hardwareConcurrency - 1)),
    }),
  }: { readonly size?: number } = {}): Layer.Layer<
    PdfEngine,
    PdfEngineError,
    Worker.WorkerPlatform | Worker.Spawner | FileSystem.FileSystem | Path.Path
  > =>
    Layer.effect(
      PdfEngine,
      Effect.map(makePool(Math.max(1, Math.floor(size)), connectToWorker), withOpen),
    ).pipe(
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
    );

  static readonly layerInProcess: Layer.Layer<
    PdfEngine,
    PdfEngineError,
    FileSystem.FileSystem | Path.Path
  > = Layer.effect(
    PdfEngine,
    Effect.map(
      makePool(1, (scope) => RpcTest.makeClient(PdfRpcs).pipe(Scope.provide(scope))),
      withOpen,
    ),
  ).pipe(
    Layer.provide(PdfRpcHandlers),
    Layer.provide(PdfiumRuntime.layer),
    Layer.provide(PdfiumWasm.layerCompiled),
  );
}
