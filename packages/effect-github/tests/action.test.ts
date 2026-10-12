import { NodeServices } from "@effect/platform-node";
import { expect, layer } from "@effect/vitest";
import { Config, Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const fixture = new URL("fixtures/run-main.ts", import.meta.url).pathname;

const collect = Effect.fn("collectFixtureOutput")(function* collectFixtureOutput(
  command: ChildProcess.Command,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner.spawn(command);
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)),
      handle.exitCode,
    ],
    { concurrency: "unbounded" },
  );
  return { exitCode, output: `${stdout}${stderr}` };
}, Effect.scoped);

const run = Effect.fn("runMainFixture")(function* runMainFixture(scenario: string) {
  const path = yield* Config.String("PATH");
  return yield* collect(
    ChildProcess.make(process.execPath, [fixture, scenario], { env: { PATH: path } }),
  );
});

const errorLogLines = (output: string) =>
  output
    .split("\n")
    .filter((line) => line.includes("ActionFailed: Draft pull requests cannot merge"));

layer(NodeServices.layer)("runMain", (it) => {
  it.effect(
    "reports an ActionFailed message as the step error, logs it once and exits with 1",
    () =>
      Effect.gen(function* () {
        const result = yield* run("action-failed");

        expect(result.output).toContain("::error::Draft pull requests cannot merge\n");
        expect(errorLogLines(result.output)).toHaveLength(1);
        expect(result.exitCode).toBe(1);
      }),
  );

  it.effect("reports the message of any other error", () =>
    Effect.gen(function* () {
      const result = yield* run("domain-error");

      expect(result.output).toContain("::error::pnpm-lock.yaml conflicts in apps/web\n");
      expect(result.exitCode).toBe(1);
    }),
  );

  it.effect("exits with 0 and reports nothing when the action succeeds", () =>
    Effect.gen(function* () {
      const result = yield* run("succeed");

      expect(result.output).not.toContain("::error::");
      expect(result.exitCode).toBe(0);
    }),
  );

  it.effect("fails the step without logging the failure when error reporting is off", () =>
    Effect.gen(function* () {
      const result = yield* run("unreported-failure");

      expect(result.output).toContain("::error::Draft pull requests cannot merge\n");
      expect(errorLogLines(result.output)).toStrictEqual([]);
      expect(result.exitCode).toBe(1);
    }),
  );

  it.effect("logs the failure with the pretty logger on a terminal", () =>
    Effect.gen(function* () {
      const path = yield* Config.String("PATH");
      const result = yield* collect(
        ChildProcess.make(
          "script",
          ["-qec", `${process.execPath} ${fixture} pretty-failure`, "/dev/null"],
          { env: { PATH: path, TERM: "xterm" } },
        ),
      );

      const logHeaders = result.output
        .split("\n")
        .filter((line) => /ERROR\S* \(#\d+\)/u.test(line));
      expect(logHeaders).not.toStrictEqual([]);
      expect(logHeaders.filter((line) => !line.includes("\u001B[31mERROR\u001B[0m"))).toStrictEqual(
        [],
      );
      expect(result.exitCode).toBe(1);
    }),
  );
});
