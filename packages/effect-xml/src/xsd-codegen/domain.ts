import { pathToFileURL } from "node:url";
import { resolve as resolveModule } from "import-meta-resolve";
import { Effect, FileSystem, Option, Path, Predicate, Schema } from "effect";
import { XsdCodegenError } from "../errors/xsd-codegen-error.ts";

const ExportedFunction = Schema.declare(Predicate.isFunction, { expected: "a function" });

const decodeObject = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown));

export interface DomainOptions {
  /** Name of the export that holds the domain object. */
  readonly export: string;
  /** The generated file: the module specifier resolves from it, as its import does. */
  readonly importer: string;
  /** Module specifier of the domain, as the generated file imports it. */
  readonly module: string;
}

export interface Domain {
  readonly export: string;
  readonly keys: readonly string[];
  readonly module: string;
}

export const parseDomainTarget = (target: string) => {
  const hash = target.lastIndexOf("#");
  return hash <= 0 || hash === target.length - 1
    ? Option.none()
    : Option.some({ export: target.slice(hash + 1), module: target.slice(0, hash) });
};

export const describeDomainKey = (key: string) =>
  !key.startsWith("xs:") && key.includes(".") ? `element ${key}` : `type ${key}`;

export const loadDomain = Effect.fn("XsdCodegen.loadDomain")(function* loadDomainObject(
  options: DomainOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const importer = path.resolve(options.importer);
  const parent = pathToFileURL(importer).href;
  const unresolved = (cause: unknown) =>
    new XsdCodegenError({
      cause,
      message: `The module ${options.module} of the domain cannot be resolved from the generated file.`,
      path: importer,
    });
  const url = yield* Effect.try({
    catch: unresolved,
    try: () => resolveModule(options.module, parent),
  });
  const file = yield* path.fromFileUrl(new URL(url)).pipe(Effect.mapError(unresolved));
  if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) {
    return yield* unresolved(url);
  }
  const exported = yield* Effect.tryPromise({
    catch: (cause) =>
      new XsdCodegenError({
        cause,
        message: `The module ${options.module} of the domain could not be loaded.`,
        path: importer,
      }),
    try: async () => {
      const namespace: unknown = await import(url);
      return decodeObject(namespace).pipe(
        Option.flatMap((module) => decodeObject(module[options.export])),
      );
    },
  });
  if (Option.isNone(exported)) {
    return yield* new XsdCodegenError({
      message: `The module ${options.module} does not export an object named ${options.export}, which the domain names.`,
      path: importer,
    });
  }
  const entries = Object.entries(exported.value);
  const invalid = entries.find(([, value]) => !Schema.is(ExportedFunction)(value));
  if (invalid !== undefined) {
    return yield* new XsdCodegenError({
      message: `The domain ${options.export} of the module ${options.module} maps the ${describeDomainKey(invalid[0])} to a value that is not a function.`,
      path: importer,
    });
  }
  const result: Domain = {
    export: options.export,
    keys: entries.map(([key]) => key),
    module: options.module,
  };
  return result;
});
