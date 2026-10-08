import { Duration, Effect, Exit, FileSystem, Option, Path } from "effect";
import type { Scope } from "effect";
import { XmlDocument, XmlElement, xmlRegisterInputProvider } from "libxml2-wasm";

const XSD_NAMESPACE = "http://www.w3.org/2001/XMLSchema";

const SCHEMA_REFERENCES: ReadonlySet<string> = new Set([
  "import",
  "include",
  "override",
  "redefine",
]);

const URL_SCHEME = /^[a-z][a-z\d+.-]*:/iu;

const loadedSchemas = new Map<string, { readonly bytes: Uint8Array; readonly holders: number }>();
const openSchemas = new Map<number, { readonly bytes: Uint8Array; readonly offset: number }>();
const handles = { next: 1 };

const toFilePath = (path: Path.Path, filename: string): Option.Option<string> => {
  if (!URL_SCHEME.test(filename)) {
    return Option.some(path.resolve(filename));
  }
  if (!filename.startsWith("file:") || !URL.canParse(filename)) {
    return Option.none();
  }
  return Effect.runSync(Effect.option(path.fromFileUrl(new URL(filename))));
};

const resolveLocation = (path: Path.Path, base: string, location: string) => {
  if (URL_SCHEME.test(location)) {
    return location;
  }
  return URL_SCHEME.test(base)
    ? new URL(location, base).href
    : path.join(path.dirname(base), location);
};

const registerMemoryProvider = Effect.runSync(
  Effect.cachedWithTTL(
    Effect.gen(function* registerProvider() {
      const path = yield* Path.Path;
      const find = (filename: string) =>
        Option.flatMapNullishOr(toFilePath(path, filename), (file) => loadedSchemas.get(file));
      return xmlRegisterInputProvider({
        close: (handle) => openSchemas.delete(handle),
        match: (filename) => Option.isSome(find(filename)),
        open: (filename) =>
          Option.getOrUndefined(
            Option.map(find(filename), ({ bytes }) => {
              const handle = handles.next;
              handles.next += 1;
              openSchemas.set(handle, { bytes, offset: 0 });
              return handle;
            }),
          ),
        read: (handle, buffer) => {
          const open = openSchemas.get(handle);
          if (open === undefined) {
            return -1;
          }
          const chunk = open.bytes.subarray(open.offset, open.offset + buffer.byteLength);
          buffer.set(chunk);
          openSchemas.set(handle, { bytes: open.bytes, offset: open.offset + chunk.byteLength });
          return chunk.byteLength;
        },
      });
    }),
    (exit) => (Exit.isSuccess(exit) && exit.value ? Duration.infinity : Duration.zero),
  ),
);

const schemaLocations = (document: XmlDocument) => {
  const locations: string[] = [];
  for (let child = document.root.firstChild; child !== null; child = child.next) {
    if (
      child instanceof XmlElement &&
      child.namespaceUri === XSD_NAMESPACE &&
      SCHEMA_REFERENCES.has(child.name)
    ) {
      const location = child.attr("schemaLocation")?.value;
      if (location !== undefined) {
        locations.push(location);
      }
    }
  }
  return locations;
};

export const provideImportedSchemas: (
  root: XmlDocument,
  url: string,
  option: number,
) => Effect.Effect<void, never, Scope.Scope | FileSystem.FileSystem | Path.Path> = Effect.fn(
  "Xsd.provideImportedSchemas",
)(function* provideImportedSchemasProgram(root, url, option) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* registerMemoryProvider;

  const found = new Map<string, Uint8Array>();
  const pending = schemaLocations(root).map((location) => resolveLocation(path, url, location));
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const location = next;
    const file = toFilePath(path, location);
    if (Option.isNone(file) || found.has(file.value)) {
      continue;
    }
    const bytes = yield* Effect.option(fs.readFile(file.value));
    if (Option.isNone(bytes)) {
      continue;
    }
    found.set(file.value, bytes.value);
    const nested = yield* Effect.acquireUseRelease(
      Effect.try(() => XmlDocument.fromBuffer(bytes.value, { option, url: location })),
      (document) => Effect.sync(() => schemaLocations(document)),
      (document) =>
        Effect.sync(() => {
          document.dispose();
        }),
    ).pipe(Effect.orElseSucceed((): readonly string[] => []));
    pending.push(
      ...nested.map((nestedLocation) => resolveLocation(path, location, nestedLocation)),
    );
  }

  yield* Effect.acquireRelease(
    Effect.sync(() => {
      for (const [file, bytes] of found) {
        loadedSchemas.set(file, { bytes, holders: (loadedSchemas.get(file)?.holders ?? 0) + 1 });
      }
    }),
    () =>
      Effect.sync(() => {
        for (const file of found.keys()) {
          const loaded = loadedSchemas.get(file);
          if (loaded === undefined || loaded.holders <= 1) {
            loadedSchemas.delete(file);
          } else {
            loadedSchemas.set(file, { bytes: loaded.bytes, holders: loaded.holders - 1 });
          }
        }
      }),
  );
});
