import { Effect, FileSystem, Stream } from "effect";
import type { Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { XsdCodegenError } from "../errors/xsd-codegen-error.ts";
import * as Xsd from "../xsd.ts";
import type { XsdSchemaSource } from "../xsd.ts";
import { compileSchema } from "./compile.ts";
import { loadDomain } from "./domain.ts";
import type { DomainOptions } from "./domain.ts";
import { readSchemaDocument } from "./schema-document.ts";

export const DEFAULT_RUNTIME = "@computis/effect-xml/xsd-codegen/runtime";

export interface GenerateOptions {
  /** Object of functions keyed by XSD type (`xs:date` for a built-in) or `<OwnerType>.<element>`: `domain.Key(GeneratedType)`. */
  readonly domain?: DomainOptions;
  /** Formats the code: `command` reads stdin and writes stdout, `{file}` in `args` becomes `path`. */
  readonly format?: FormatOptions;
  /** Prefix of the root element. Required when the local elements are unqualified. */
  readonly prefix?: string;
  /** Name of the global element that becomes the root of the Schema. */
  readonly root: string;
  /** Import specifier of the runtime helpers, `@computis/effect-xml/xsd-codegen/runtime` by default. */
  readonly runtime?: string;
  readonly xsd: XsdSchemaSource;
}

interface FormatOptions {
  readonly args: readonly string[];
  readonly command: string;
  readonly path: string;
}

const format = Effect.fn("XsdCodegen.format")(function* formatCode(
  code: string,
  options: FormatOptions,
) {
  const { command } = options;
  const args = options.args.map((arg) => arg.replaceAll("{file}", options.path));
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const [formatted, stderr, exitCode] = yield* Effect.scoped(
    Effect.gen(function* runFormatter() {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, args, {
          stdin: Stream.make(new TextEncoder().encode(code)),
        }),
      );
      return yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );
    }),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new XsdCodegenError({
          cause,
          message: `Cannot run '${command}': ${cause.message}`,
          path: options.path,
        }),
    ),
  );
  if (exitCode !== 0) {
    return yield* new XsdCodegenError({
      message: `'${[command, ...args].join(" ")}' exited with code ${String(exitCode)}: ${stderr.trim()}`,
      path: options.path,
    });
  }
  return formatted;
});

export const generate: (
  options: GenerateOptions,
) => Effect.Effect<
  string,
  XsdCodegenError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> = Effect.fn("XsdCodegen.generate")(function* generateSchema(options) {
  const fs = yield* FileSystem.FileSystem;
  const { xsd } = options;
  const source =
    "path" in xsd
      ? {
          contents: yield* fs.readFile(xsd.path).pipe(
            Effect.mapError(
              (cause) =>
                new XsdCodegenError({
                  cause,
                  message: "The XSD file could not be read.",
                  path: xsd.path,
                }),
            ),
          ),
          url: xsd.path,
        }
      : xsd;
  yield* Effect.scoped(Xsd.make({ schema: source })).pipe(
    Effect.mapError(
      (cause) => new XsdCodegenError({ cause, message: cause.message, path: source.url }),
    ),
  );
  const document = yield* readSchemaDocument(source);
  const domain = options.domain === undefined ? undefined : yield* loadDomain(options.domain);
  const code = yield* Effect.fromResult(
    compileSchema(document, {
      domain,
      prefix: options.prefix,
      root: options.root,
      runtime: options.runtime ?? DEFAULT_RUNTIME,
      source: source.url.split(/[\\/]/u).at(-1) ?? source.url,
    }),
  );
  return options.format === undefined ? code : yield* format(code, options.format);
});
