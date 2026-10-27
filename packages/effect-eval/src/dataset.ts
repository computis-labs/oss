import {
  Array as Arr,
  Config,
  Effect,
  FileSystem,
  Option,
  Path,
  Predicate,
  Result,
  Schema,
  Stream,
  pipe,
} from "effect";
import { EvalDatasetError } from "./errors/eval-dataset-error.ts";
import { EvalPrivacyError } from "./errors/eval-privacy-error.ts";
import { whenDefined } from "./object.ts";
import { resolveDenylist, scan } from "./privacy.ts";
import type { Finding, Privacy } from "./privacy.ts";
import { seededRandom } from "./statistics.ts";

export interface Case<A> {
  readonly id: string;
  readonly tags: readonly string[];
  readonly input: A;
}

export const SkipSchema = Schema.TaggedStruct("Skip", {
  id: Schema.String,
  reason: Schema.String,
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
});

export type Skip = typeof SkipSchema.Type;

export const isSkip = Schema.is(SkipSchema);

export interface Item<A> {
  readonly entry: Result.Result<Case<A>, Skip>;
  readonly raw: Option.Option<Schema.Json>;
}

export interface Identify<A> {
  readonly id: (input: A) => string;
  readonly tags?: (input: A) => readonly string[];
}

export interface Dataset<A, E = never, R = never> {
  readonly items: Stream.Stream<Item<A>, E, R>;
  readonly sensitive: boolean;
}

export interface Loaded<A> {
  readonly cases: readonly Case<A>[];
  readonly skipped: readonly Skip[];
}

export interface FilterOptions {
  readonly ids?: readonly string[];
  readonly tags?: readonly string[];
  readonly limit?: number;
}

export interface SampleOptions {
  readonly size: number;
  readonly seed: string;
  readonly stratifyBy?: string;
}

const LINE_BREAK = "\n";
const TAG_SEPARATOR = ":";
const NOT_JSON = "not JSON: the input cannot be scanned";

export const fromItems = <A, E, R>(
  items: Stream.Stream<Item<A>, E, R>,
  options: { readonly sensitive?: boolean } = {},
): Dataset<A, E, R> => ({
  items,
  sensitive: options.sensitive ?? false,
});

export const asSensitive = <A, E, R>(self: Dataset<A, E, R>): Dataset<A, E, R> => ({
  ...self,
  sensitive: true,
});

export const skip = (
  id: string,
  reason: string,
  options: { readonly tags?: readonly string[] } = {},
): Skip => SkipSchema.make({ id, reason, ...whenDefined(options.tags, (tags) => ({ tags })) });

const caseItem = <A>(
  identify: Identify<A>,
  input: A,
  raw: Option.Option<Schema.Json>,
): Item<A> => ({
  entry: Result.succeed({ id: identify.id(input), input, tags: identify.tags?.(input) ?? [] }),
  raw,
});

const entryItem =
  <A>(identify: Identify<A>) =>
  (value: A | Skip): Item<A> =>
    isSkip(value)
      ? { entry: Result.fail(value), raw: Option.none() }
      : caseItem(identify, value, Option.none());

const caseOf = <A>(item: Item<A>) => Result.getSuccess(item.entry);

const idOf = <A>(item: Item<A>) => Result.merge(item.entry).id;

const datasetError = (path: string, message: string) => (cause: unknown) =>
  new EvalDatasetError({ cause, message, path });

const resolveFile = Effect.fn("Dataset.resolveFile")(function* resolveFile(path: string | URL) {
  if (Predicate.isString(path)) {
    return path;
  }

  const paths = yield* Path.Path;

  return yield* paths
    .fromFileUrl(path)
    .pipe(Effect.mapError(datasetError(path.href, "The dataset URL is not a file URL.")));
});

const readText = Effect.fn("Dataset.readText")(function* readText(file: string) {
  const fs = yield* FileSystem.FileSystem;

  return yield* fs
    .readFileString(file)
    .pipe(Effect.mapError(datasetError(file, "The dataset file cannot be read.")));
});

const isJson = Schema.is(Schema.Json);

const decodeElements = <S extends Schema.Top>(
  schema: S,
  identify: Identify<S["Type"]>,
  file: string,
  raws: readonly Schema.Json[],
) =>
  pipe(
    raws,
    Effect.forEach((raw, index) =>
      Schema.decodeUnknownEffect(schema)(raw).pipe(
        Effect.mapError(datasetError(file, `Entry ${String(index)} does not match the schema.`)),
        Effect.map((input) => caseItem(identify, input, Option.some(raw))),
      ),
    ),
  );

const JsonArray = Schema.fromJsonString(Schema.Array(Schema.Json));

const JsonValue = Schema.fromJsonString(Schema.Json);

const readJson = <S extends Schema.Top>(
  schema: S,
  path: string | URL,
  identify: Identify<S["Type"]>,
) =>
  Effect.gen(function* readJsonArray() {
    const file = yield* resolveFile(path);
    const text = yield* readText(file);

    const raws = yield* Schema.decodeUnknownEffect(JsonArray)(text).pipe(
      Effect.mapError(datasetError(file, "The dataset is not a JSON array.")),
    );

    return yield* decodeElements(schema, identify, file, raws);
  });

export const json = <S extends Schema.Top>(
  schema: S,
  path: string | URL,
  identify: Identify<S["Type"]>,
): Dataset<
  S["Type"],
  EvalDatasetError,
  FileSystem.FileSystem | Path.Path | S["DecodingServices"]
> => fromItems(Stream.fromIterableEffect(readJson(schema, path, identify)));

export const jsonl = <S extends Schema.Top>(
  schema: S,
  path: string | URL,
  identify: Identify<S["Type"]>,
): Dataset<
  S["Type"],
  EvalDatasetError,
  FileSystem.FileSystem | Path.Path | S["DecodingServices"]
> =>
  fromItems(
    Stream.fromIterableEffect(
      Effect.gen(function* readJsonLines() {
        const file = yield* resolveFile(path);
        const text = yield* readText(file);

        const raws = yield* pipe(
          text.split(LINE_BREAK).filter((line) => line.trim().length > 0),
          Effect.forEach((line, index) =>
            Schema.decodeUnknownEffect(JsonValue)(line).pipe(
              Effect.mapError(datasetError(file, `Line ${String(index + 1)} is not JSON.`)),
            ),
          ),
        );

        return yield* decodeElements(schema, identify, file, raws);
      }),
    ),
  );

export const directory = <A, E, R>(
  path: string,
  options: {
    readonly extension: string;
    readonly read: (file: string) => Effect.Effect<A, E, R>;
  } & Identify<A>,
): Dataset<A, E | EvalDatasetError, R | FileSystem.FileSystem | Path.Path> =>
  fromItems(
    Stream.fromIterableEffect(
      Effect.gen(function* readFolder() {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;

        const names = yield* fs
          .readDirectory(path)
          .pipe(Effect.mapError(datasetError(path, "The dataset folder cannot be read.")));

        return yield* pipe(
          names.filter((name) => name.endsWith(options.extension)).toSorted(),
          Effect.forEach((name) =>
            options
              .read(paths.join(path, name))
              .pipe(Effect.map((input) => caseItem(options, input, Option.none()))),
          ),
        );
      }),
    ),
  );

export const fromIterable = <A>(entries: Iterable<A | Skip>, identify: Identify<A>): Dataset<A> =>
  fromItems(Stream.fromIterable(Array.from(entries, entryItem(identify))));

export const fromEffect = <A, E, R>(
  entries: Effect.Effect<Iterable<A | Skip>, E, R>,
  identify: Identify<A>,
): Dataset<A, E, R> =>
  fromItems(
    Stream.fromIterableEffect(
      entries.pipe(Effect.map((values) => Array.from(values, entryItem(identify)))),
    ),
  );

export const stream = <A, E, R>(
  entries: Stream.Stream<A | Skip, E, R>,
  identify: Identify<A>,
): Dataset<A, E, R> => fromItems(entries.pipe(Stream.map(entryItem(identify))));

export const optional = <S extends Schema.Top>(
  path: Config.Config<string>,
  schema: S,
  identify: Identify<S["Type"]>,
): Dataset<
  S["Type"],
  EvalDatasetError | Config.ConfigError,
  FileSystem.FileSystem | Path.Path | S["DecodingServices"]
> =>
  fromItems(
    Stream.fromIterableEffect(
      Config.option(path).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed<readonly Item<S["Type"]>[]>([]),
            onSome: (file) => readJson(schema, file, identify),
          }),
        ),
      ),
    ),
    { sensitive: true },
  );

const collected = <A, B, E, R, E2 = never, R2 = never>(
  self: Dataset<A, E, R>,
  f: (items: readonly Item<A>[]) => Effect.Effect<readonly Item<B>[], E2, R2>,
): Dataset<B, E | E2, R | R2> =>
  fromItems(Stream.fromIterableEffect(Stream.runCollect(self.items).pipe(Effect.flatMap(f))), {
    sensitive: self.sensitive,
  });

export const concat =
  <B, E2, R2>(that: Dataset<B, E2, R2>) =>
  <A, E, R>(self: Dataset<A, E, R>): Dataset<A | B, E | E2, R | R2> =>
    fromItems<A | B, E | E2, R | R2>(Stream.concat(self.items, that.items), {
      sensitive: self.sensitive || that.sensitive,
    });

const tagsOf = <A>(item: Item<A>): readonly string[] => Result.merge(item.entry).tags ?? [];

export const filter =
  (options: FilterOptions) =>
  <A, E, R>(self: Dataset<A, E, R>): Dataset<A, E, R> =>
    collected(self, (items) => {
      const ids = options.ids === undefined ? undefined : new Set(options.ids);
      const tags = new Set(options.tags);

      const kept = items.filter(
        (item) =>
          (ids === undefined || ids.has(idOf(item))) &&
          (tags.size === 0 || tagsOf(item).some((tag) => tags.has(tag))),
      );

      return Effect.succeed(kept.slice(0, options.limit));
    });

export const sample =
  (options: SampleOptions) =>
  <A, E, R>(self: Dataset<A, E, R>): Dataset<A, E, R> =>
    collected(self, (items) => {
      const random = seededRandom(options.seed);
      const cases = items.filter((item) => Result.isSuccess(item.entry));

      const shuffled = cases
        .map((item) => [random(), item] as const)
        .toSorted(([left], [right]) => left - right)
        .map(([, item]) => item);

      const head = `${options.stratifyBy ?? ""}${TAG_SEPARATOR}`;

      const strata = Arr.groupBy(shuffled, (item) =>
        options.stratifyBy === undefined
          ? ""
          : (tagsOf(item).find((tag) => tag.startsWith(head)) ?? ""),
      );

      const size = Math.min(options.size, cases.length);

      const quotas = Object.entries(strata).map(([stratum, members]) => {
        const share = (members.length / cases.length) * size;

        return { members, share, stratum, taken: Math.floor(share) };
      });

      const missing = size - quotas.reduce((total, quota) => total + quota.taken, 0);

      const bonus = new Set(
        quotas
          .toSorted((left, right) => right.share - right.taken - (left.share - left.taken))
          .slice(0, missing)
          .map((quota) => quota.stratum),
      );

      const chosen = new Set(
        quotas.flatMap((quota) =>
          quota.members.slice(0, quota.taken + (bonus.has(quota.stratum) ? 1 : 0)).map(idOf),
        ),
      );

      return Effect.succeed(
        items.filter((item) => Result.isFailure(item.entry) || chosen.has(idOf(item))),
      );
    });

export const guard =
  (privacy: Privacy) =>
  <A, E, R>(self: Dataset<A, E, R>): Dataset<A, E | EvalPrivacyError | Config.ConfigError, R> =>
    collected(self, (items) =>
      Effect.gen(function* guardPrivacy() {
        const denylist = yield* resolveDenylist(privacy);

        const findings = items.flatMap((item) =>
          Option.match(caseOf(item), {
            onNone: () => [],
            onSome: (entry) => {
              const options = { denylist, rules: privacy.rules };

              const found: readonly Finding[] = [
                ...(isJson(entry.input)
                  ? scan(entry.id, entry.input, options)
                  : [{ case: entry.id, path: "", rule: NOT_JSON }]),
                ...Option.match(item.raw, {
                  onNone: (): readonly Finding[] => [],
                  onSome: (raw) => scan(entry.id, raw, options),
                }),
              ];

              return Arr.dedupeWith(
                found,
                (left, right) => left.path === right.path && left.rule === right.rule,
              );
            },
          }),
        );

        if (findings.length > 0) {
          return yield* new EvalPrivacyError({ findings });
        }

        return items;
      }),
    );

export const load = Effect.fn("Dataset.load")(function* load<A, E, R>(self: Dataset<A, E, R>) {
  const items = yield* Stream.runCollect(self.items);
  const ids = items.map(idOf);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);

  if (duplicate !== undefined) {
    return yield* new EvalDatasetError({
      message: `Two cases have the id ${duplicate}.`,
      path: "",
    });
  }

  return {
    cases: items.flatMap((item) => Option.toArray(caseOf(item))),
    skipped: items.flatMap((item) => Option.toArray(Result.getFailure(item.entry))),
  } satisfies Loaded<A>;
});
