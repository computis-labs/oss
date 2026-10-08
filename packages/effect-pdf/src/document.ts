import { Effect, Scope, SynchronizedRef } from "effect";
import type { RpcClientError } from "effect/rpc";
import { documentKind } from "#effect-pdf/classify";
import type { PdfPool, PdfRpcClient, PdfWorkerLease } from "#effect-pdf/engine";
import { selectedPages } from "#effect-pdf/handle";
import { DEFAULT_PAGE_IMAGE_DPI } from "#effect-pdf/page-images";
import type { PdfDocument } from "#effect-pdf/types";

const FAN_OUT_PAGES_PER_WORKER = 4;

interface ReplicaState {
  readonly edited: boolean;
  readonly replicas: readonly PdfWorkerLease[];
}

export const openDocument = (engine: PdfPool) =>
  Effect.fn("PdfEngine.open")(function* openPdf(
    bytes: Uint8Array,
    { password = "" }: { readonly password?: string } = {},
  ) {
    const documentScope = yield* Effect.scope;
    const openOn = (source: Uint8Array<ArrayBuffer>) => (client: PdfRpcClient, document: number) =>
      client.Open({ bytes: source, document, password });
    const { lease: primary, value: pages } = yield* engine.lease(
      new Set(),
      openOn(new Uint8Array(bytes)),
    );
    const pageCount = pages.length;
    const retained =
      engine.size > 1 && pageCount >= 2 * FAN_OUT_PAGES_PER_WORKER
        ? new Uint8Array(bytes)
        : undefined;
    const replicaState = yield* SynchronizedRef.make<ReplicaState>({ edited: false, replicas: [] });

    const onPrimary = <A, E>(
      request: (
        client: PdfRpcClient,
        document: number,
      ) => Effect.Effect<A, E | RpcClientError.RpcClientError>,
    ) => engine.call(primary, request);

    const pagesOf = (selection: readonly number[] | undefined) =>
      Effect.fromResult(selectedPages({ pageCount }, selection));

    const workersFor = Effect.fn("PdfDocument.workersFor")(function* chooseWorkers(
      selected: readonly number[],
    ) {
      const wanted = Math.min(engine.size, Math.floor(selected.length / FAN_OUT_PAGES_PER_WORKER));
      if (retained === undefined || wanted <= 1) {
        return [primary];
      }
      const replicas = yield* SynchronizedRef.modifyEffect(replicaState, (state) =>
        state.edited
          ? Effect.succeed<[readonly PdfWorkerLease[], ReplicaState]>([[], state])
          : Effect.reduce(
              Array.from({ length: Math.max(0, wanted - 1 - state.replicas.length) }),
              () => state.replicas,
              (opened) =>
                engine
                  .lease(
                    new Set([primary.worker, ...opened.map(({ worker }) => worker)]),
                    openOn(new Uint8Array(retained)),
                  )
                  .pipe(
                    Scope.provide(documentScope),
                    Effect.map(({ lease }) => [...opened, lease]),
                    Effect.tapError((failure) =>
                      Effect.logWarning("effectPdf.replica.unavailable", {
                        reason: failure.message,
                      }),
                    ),
                    Effect.orElseSucceed(() => opened),
                  ),
            ).pipe(
              Effect.map((all): [readonly PdfWorkerLease[], ReplicaState] => [
                all,
                { edited: false, replicas: all },
              ]),
            ),
      );
      return [primary, ...replicas.slice(0, wanted - 1)];
    });

    const fanOut = Effect.fn("PdfDocument.fanOut")(function* fanOutPages<A, E>(
      selection: readonly number[] | undefined,
      request: (
        client: PdfRpcClient,
        document: number,
        pages: readonly number[],
      ) => Effect.Effect<readonly A[], E | RpcClientError.RpcClientError>,
    ) {
      const selected = yield* pagesOf(selection);
      const workers = yield* workersFor(selected);
      const chunk = Math.ceil(selected.length / workers.length);
      const parts = yield* Effect.all(
        workers.map((lease, index) =>
          engine.call(lease, (client, document) =>
            request(client, document, selected.slice(index * chunk, (index + 1) * chunk)),
          ),
        ),
        { concurrency: "unbounded" },
      );
      return parts.flat();
    });

    const markEdited = SynchronizedRef.update(replicaState, (state) => ({
      ...state,
      edited: true,
    }));

    const document: PdfDocument = {
      addSignatureField: Effect.fn("PdfDocument.addSignatureField")(
        function* addSignatureField(field) {
          yield* pagesOf([field.page]);
          yield* markEdited;
          return yield* onPrimary((client, id) =>
            client.AddSignatureField({ document: id, field }),
          );
        },
      ),
      classify: fanOut(undefined, (client, id, selected) =>
        client.Classify({ document: id, pages: selected }),
      ).pipe(
        Effect.map((classified) => ({ kind: documentKind(classified), pages: classified })),
        Effect.withSpan("PdfDocument.classify"),
      ),
      fields: onPrimary((client, id) => client.Fields({ document: id })).pipe(
        Effect.withSpan("PdfDocument.fields"),
      ),
      find: Effect.fn("PdfDocument.find")(function* findInDocument(pattern, selection) {
        return yield* fanOut(selection?.pages, (client, id, selected) =>
          client.Find({
            document: id,
            flags: pattern.flags,
            pages: selected,
            source: pattern.source,
          }),
        );
      }),
      pageCount,
      pageImages: Effect.fn("PdfDocument.pageImages")(function* documentPageImages(selection) {
        const dpi = selection?.dpi ?? DEFAULT_PAGE_IMAGE_DPI;
        return yield* fanOut(selection?.pages, (client, id, selected) =>
          client.PageImages({ document: id, dpi, pages: selected }),
        );
      }),
      pages,
      render: Effect.fn("PdfDocument.render")(function* renderDocumentPage(page, size) {
        yield* pagesOf([page]);
        const workers = yield* workersFor(pages.map(({ index }) => index));
        return yield* engine.call(workers[page % workers.length] ?? primary, (client, id) =>
          client.Render({ document: id, page, size: size ?? {} }),
        );
      }),
      save: Effect.fn("PdfDocument.save")(function* saveDocumentBytes(saveOptions) {
        return yield* onPrimary((client, id) =>
          client.Save({ document: id, incremental: saveOptions?.incremental ?? true }),
        );
      }),
      setFields: Effect.fn("PdfDocument.setFields")(function* setDocumentFields(values) {
        yield* markEdited;
        return yield* onPrimary((client, id) => client.SetFields({ document: id, values }));
      }),
      text: Effect.fn("PdfDocument.text")(function* documentText(options) {
        return yield* fanOut(options?.pages, (client, id, selected) =>
          client.Text({ document: id, layout: options?.layout ?? false, pages: selected }),
        );
      }),
    };
    return document;
  });
