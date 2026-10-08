# @computis/effect-pdf

Read, render and fill PDFs with Effect, on PDFium compiled to WebAssembly.

- `open(bytes)` opens a PDF once, for the life of its scope, and returns a document whose methods are `Effect`s: text, find, classification, page images, render to PNG, form fields, signature fields and save.
- PDFium runs in a pool of workers, so a slow or broken document does not block your program. A long document is split across the workers, and a worker that dies is replaced: only the documents it held fail.
- `form(schema)` reads and writes the form fields of a PDF through an Effect Schema.

## Install

```sh
npm install @computis/effect-pdf effect
```

It needs Effect 4. The package is ESM only. Its modules depend on no Effect platform package: the services they need (`FileSystem`, `Path`, and the workers) come from the platform layers you provide, so they work with `@effect/platform-node`, `@effect/platform-bun` or any other.

The PDFium worker needs one platform package next to it: `@effect/platform-node` on Node, `@effect/platform-bun` on Bun. To run the workers elsewhere, see [Other platforms](#other-platforms).

## Example

On Node:

```ts
import { NodeServices, NodeWorker } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { Worker } from "node:worker_threads";
import { open } from "@computis/effect-pdf";
import { PdfEngine, pdfWorkerEntry } from "@computis/effect-pdf/engine";

const PdfLive = PdfEngine.layer().pipe(
  Layer.provide(NodeWorker.layer(() => new Worker(pdfWorkerEntry))),
  Layer.provide(NodeServices.layer),
);

const program = Effect.gen(function* () {
  const document = yield* open(bytes);
  const { kind } = yield* document.classify;
  const pages = yield* document.text();
  const preview = yield* document.render(0, { width: 900 });
  return { kind, pages, preview };
}).pipe(Effect.scoped, Effect.provide(PdfLive));
```

On Bun, provide the Bun layers instead:

```ts
import { BunServices, BunWorker } from "@effect/platform-bun";

const PdfLive = PdfEngine.layer().pipe(
  Layer.provide(BunWorker.layer(() => new Worker(pdfWorkerEntry))),
  Layer.provide(BunServices.layer),
);
```

| Layer                        | Needs                                                           | Use                                                                                                                                                                     |
| ---------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PdfEngine.layer({ size? })` | `Worker.WorkerPlatform`, `Worker.Spawner`, `FileSystem`, `Path` | A pool of `size` workers. The default is one less than the CPUs, between 1 and 4, or 1 when the platform does not report them. The spawner must start `pdfWorkerEntry`. |
| `PdfEngine.layerInProcess`   | `FileSystem`, `Path`                                            | PDFium on the calling thread, with no worker. For tests and scripts.                                                                                                    |

Both read the PDFium binary from `@embedpdf/pdfium` through `FileSystem` and compile it once.

## The document

| Member                           | Returns                                                                                                                                                               |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pageCount`, `pages`             | The number of pages, and the size and rotation of each.                                                                                                               |
| `text({ pages?, layout? })`      | The text of each page, with the number of characters whose Unicode mapping is missing. `layout: true` puts the cells of a table row on one line, spaced by their gap. |
| `find(regexp, { pages? })`       | Each match with its page, its box in PDF points, the baseline origin of its first glyph and its named groups.                                                         |
| `classify`                       | Whether each page, and the document, is text, image, mixed or empty.                                                                                                  |
| `pageImages({ pages?, dpi? })`   | One image per page for a vision model: the scan itself when the page is a scan (a JPEG passes through untouched), otherwise a PNG render.                             |
| `render(page, { dpi?, width? })` | The page as a PNG.                                                                                                                                                    |
| `fields`                         | The form fields with their type, value and widgets.                                                                                                                   |
| `setFields(values)`              | Fills the fields by name.                                                                                                                                             |
| `addSignatureField(field)`       | Adds an empty signature field on a page.                                                                                                                              |
| `save({ incremental? })`         | The bytes of the document. Incremental by default, so the original bytes stay untouched.                                                                              |

Every failure is a tagged error: `PdfOpenError` (with a `reason`: `file`, `format`, `password`, `security` or `unknown`), `PdfPageError`, `PdfFormError`, `PdfSaveError` and `PdfEngineError`.

## Forms with a Schema

```ts
import { Schema } from "effect";
import { form } from "@computis/effect-pdf";

const Registration = form(
  Schema.Struct({ ragioneSociale: Schema.String, privacy: Schema.Boolean }),
);

const filled = Effect.gen(function* () {
  const document = yield* open(bytes);
  const current = yield* Registration.read(document);
  yield* Registration.write(document, { ...current, privacy: true });
  return yield* document.save();
});
```

## Other platforms

`@computis/effect-pdf/server` exports `PdfWorkerServer`, the layer the worker runs. It needs only a `WorkerRunnerPlatform`. To run the workers on another platform, write a worker entry that launches it with that platform's runner, and start that file from the `Spawner` you give `PdfEngine.layer`:

```ts
import { Layer } from "effect";
import { PdfWorkerServer } from "@computis/effect-pdf/server";

runMain(Layer.launch(PdfWorkerServer.pipe(Layer.provide(MyWorkerRunner.layer))));
```

## License

MIT
