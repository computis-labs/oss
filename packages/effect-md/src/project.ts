import { whenDefined } from "./object.ts";
import { Console, Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { compile } from "./compiler.ts";
import { PromptProjectError, PromptProjectErrorReason } from "./project-error.ts";

export interface ProjectOptions {
  readonly root: string;
  readonly runtime?: string;
  readonly format?: string;
}

export const outputName = "prompts.gen.ts";

const sourcePattern = /\.(?:prompt|partial)\.md$/u;

const argumentPattern = /(?:"[^"]*"|'[^']*'|[^\s"']+)+/gu;

const quotePattern = /"(?<double>[^"]*)"|'(?<single>[^']*)'/gu;

const render = (options: ProjectOptions) =>
  Effect.gen(function* renderProgram() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* fs.readDirectory(options.root, { recursive: true });
    const sources = yield* Effect.all(
      entries
        .filter((entry) => sourcePattern.test(entry))
        .map((entry) =>
          Effect.map(fs.readFileString(path.join(options.root, entry)), (text) => ({
            path: entry.split(path.sep).join("/"),
            text,
          })),
        ),
    );
    const cwd = path.resolve(".");
    const display = (file: string) => {
      const absolute = path.resolve(options.root, file);
      const relative = path.relative(cwd, absolute);
      return relative.startsWith("..") ? absolute : relative;
    };
    const code = yield* compile(sources, {
      displayPath: display,
      ...whenDefined(options.runtime, (runtime) => ({ runtime })),
    });
    const output = display(outputName);
    if (options.format === undefined) {
      return { code, output };
    }
    const [command, ...args] = Array.from(options.format.matchAll(argumentPattern), ([part]) =>
      part.replaceAll(quotePattern, "$<double>$<single>").replaceAll("{file}", output),
    );
    if (command === undefined) {
      return yield* PromptProjectError.make({
        detail: "The format command is empty.",
        output,
        reason: PromptProjectErrorReason.FormatFailed,
      });
    }
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const [formatted, stderr, exitCode] = yield* Effect.scoped(
      Effect.gen(function* formatProgram() {
        const handle = yield* spawner
          .spawn(
            ChildProcess.make(command, args, {
              stdin: Stream.make(new TextEncoder().encode(code)),
            }),
          )
          .pipe(
            Effect.mapError((platformError) =>
              PromptProjectError.make({
                detail: `Cannot run '${command}' (${platformError.message}). Check that it is installed and on the PATH.`,
                output,
                reason: PromptProjectErrorReason.FormatFailed,
              }),
            ),
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
    );
    if (exitCode !== 0) {
      return yield* PromptProjectError.make({
        detail: [`'${options.format}' exited with code ${exitCode}.`, stderr.trim()]
          .filter((line) => line.length > 0)
          .join("\n"),
        output,
        reason: PromptProjectErrorReason.FormatFailed,
      });
    }
    return { code: formatted, output };
  });

const readCurrent = (output: string) =>
  Effect.gen(function* readCurrentProgram() {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(output);
    return exists ? yield* fs.readFileString(output) : null;
  });

export const generate = (options: ProjectOptions) =>
  Effect.gen(function* generateProgram() {
    const fs = yield* FileSystem.FileSystem;
    const { code, output } = yield* render(options);
    const current = yield* readCurrent(output);
    if (current === code) {
      return { changed: false, output };
    }
    yield* fs.writeFileString(output, code);
    return { changed: true, output };
  });

export const check = (options: ProjectOptions) =>
  Effect.gen(function* checkProgram() {
    const { code, output } = yield* render(options);
    const current = yield* readCurrent(output);
    if (current !== code) {
      return yield* PromptProjectError.make({
        detail:
          current === null
            ? "The generated file does not exist. Run 'effect-md generate'."
            : "The generated file is out of date. Run 'effect-md generate'.",
        output,
        reason: PromptProjectErrorReason.Outdated,
      });
    }
    return { output };
  });

export const report = (result: { readonly changed: boolean; readonly output: string }) =>
  Console.log(result.changed ? `Wrote ${result.output}` : `${result.output} is up to date`);

export const watch = (options: ProjectOptions) =>
  Effect.gen(function* watchProgram() {
    const fs = yield* FileSystem.FileSystem;
    const once = generate(options).pipe(
      Effect.matchEffect({
        onFailure: (failure) => Console.error(failure.message),
        onSuccess: report,
      }),
    );
    yield* Console.log(`Watching ${options.root} for prompt changes`);
    yield* Stream.merge(
      Stream.make(options.root),
      fs.watch(options.root, { recursive: true }).pipe(
        Stream.map((event) => event.path),
        Stream.filter((changed) => sourcePattern.test(changed)),
      ),
    ).pipe(
      Stream.debounce("50 millis"),
      Stream.runForEach(() => once),
    );
  });
