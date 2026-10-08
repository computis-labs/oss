import { Console, Effect, FileSystem, Option } from "effect";
import { CliError, Command, Flag } from "effect/cli";
import { DEFAULT_RUNTIME, generate } from "./xsd-codegen/generate.ts";
import { parseDomainTarget } from "./xsd-codegen/domain.ts";

const flags = {
  domain: Flag.String("domain").pipe(
    Flag.withDescription(
      "<module>#<export>: an object of functions keyed by XSD type name (xs:date for a built-in) or <generated owner type>.<element name>; the generated type becomes domain.Key(Type). <module> resolves from --out.",
    ),
    Flag.filterMap(parseDomainTarget, (target) => `Expected <module>#<export>, got ${target}`),
    Flag.optional,
  ),
  format: Flag.String("format").pipe(
    Flag.withDescription(
      "Command that formats the generated code: it reads stdin and writes stdout, for example 'oxfmt'.",
    ),
    Flag.optional,
  ),
  formatArg: Flag.String("format-arg").pipe(
    Flag.withDescription(
      "Argument of the --format command, repeat it for each argument. '{file}' is replaced with the output path, for example '--format-arg=--stdin-filepath={file}'.",
    ),
    Flag.atLeast(0),
  ),
  out: Flag.String("out").pipe(Flag.withDescription("Path of the generated TypeScript file.")),
  prefix: Flag.String("prefix").pipe(
    Flag.withDescription(
      "Prefix of the root element. Required when the local elements of the XSD are unqualified.",
    ),
    Flag.optional,
  ),
  root: Flag.String("root").pipe(
    Flag.withDescription("Name of the global element that becomes the root of the Schema."),
  ),
  runtime: Flag.String("runtime").pipe(
    Flag.withDescription(
      `Import specifier of the runtime helpers. Defaults to '${DEFAULT_RUNTIME}'.`,
    ),
    Flag.optional,
  ),
  xsd: Flag.File("xsd", { mustExist: true }).pipe(Flag.withDescription("Path of the XSD file.")),
};

const generateCommand = Command.make("generate", flags, (config) =>
  Effect.gen(function* generateFile() {
    const fs = yield* FileSystem.FileSystem;
    if (Option.isNone(config.format) && config.formatArg.length > 0) {
      return yield* new CliError.MissingOption({ option: "format" });
    }
    const code = yield* generate({
      ...Option.match(config.domain, {
        onNone: () => ({}),
        onSome: (domain) => ({ domain: { ...domain, importer: config.out } }),
      }),
      ...Option.match(config.format, {
        onNone: () => ({}),
        onSome: (command) => ({ format: { args: config.formatArg, command, path: config.out } }),
      }),
      ...Option.match(config.prefix, { onNone: () => ({}), onSome: (prefix) => ({ prefix }) }),
      ...Option.match(config.runtime, { onNone: () => ({}), onSome: (runtime) => ({ runtime }) }),
      root: config.root,
      xsd: { path: config.xsd },
    });
    const current = (yield* fs.exists(config.out)) ? yield* fs.readFileString(config.out) : null;
    if (current === code) {
      return yield* Console.log(`${config.out} is up to date`);
    }
    yield* fs.writeFileString(config.out, code);
    return yield* Console.log(`Wrote ${config.out}`);
  }).pipe(
    Effect.tapError((failure) =>
      Console.error("path" in failure ? `${failure.path}: ${failure.message}` : failure.message),
    ),
  ),
).pipe(Command.withDescription("Generate Effect Schemas with XML annotations from an XSD."));

export const cli = Command.make("effect-xml").pipe(
  Command.withDescription("Tools for @computis/effect-xml."),
  Command.withSubcommands([generateCommand]),
);

export const main = Command.run(cli, { version: "0.0.0" });
