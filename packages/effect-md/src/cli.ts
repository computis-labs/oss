#!/usr/bin/env node
import { whenDefined } from "./object.ts";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { check, generate, report, watch } from "./project.ts";

const flags = {
  format: Flag.String("format").pipe(
    Flag.withDescription(
      "Command that formats the generated code: it reads stdin and writes stdout. '{file}' is replaced with the output path, for example 'oxfmt --stdin-filepath={file}'.",
    ),
    Flag.optional,
  ),
  root: Flag.Directory("root", { mustExist: true }).pipe(
    Flag.withDescription(
      "Folder with the .prompt.md and .partial.md files. The generated prompts.gen.ts goes in this folder.",
    ),
  ),
  runtime: Flag.String("runtime").pipe(
    Flag.withDescription(
      "Import specifier of the effect-md runtime. Defaults to '@computis/effect-md/runtime'.",
    ),
    Flag.optional,
  ),
};

const toOptions = (config: {
  readonly format: Option.Option<string>;
  readonly root: string;
  readonly runtime: Option.Option<string>;
}) => ({
  ...whenDefined(Option.getOrUndefined(config.format), (format) => ({ format })),
  ...whenDefined(Option.getOrUndefined(config.runtime), (runtime) => ({ runtime })),
  root: config.root,
});

const reportFailure = <A, E extends { readonly message: string }, R>(
  self: Effect.Effect<A, E, R>,
) => Effect.tapError(self, (failure) => Console.error(failure.message));

const cli = Command.make("effect-md").pipe(
  Command.withDescription("Compile .prompt.md files into typed Effect AI prompts."),
  Command.withSubcommands([
    Command.make("generate", flags, (config) =>
      generate(toOptions(config)).pipe(Effect.flatMap(report), reportFailure),
    ).pipe(Command.withDescription("Write prompts.gen.ts when it changed.")),
    Command.make("check", flags, (config) =>
      check(toOptions(config)).pipe(
        Effect.flatMap((result) => Console.log(`${result.output} is up to date`)),
        reportFailure,
      ),
    ).pipe(Command.withDescription("Fail when prompts.gen.ts is missing or out of date.")),
    Command.make("watch", flags, (config) => watch(toOptions(config)).pipe(reportFailure)).pipe(
      Command.withDescription("Generate prompts.gen.ts on every change of a prompt file."),
    ),
  ]),
);

NodeRuntime.runMain(
  Command.run(cli, { version: "0.0.0" }).pipe(Effect.provide(NodeServices.layer)),
  { disableErrorReporting: true },
);
