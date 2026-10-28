import { createServer } from "node:http";
import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { afterEach, describe, expect, it, layer, vi } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Redacted, Schema } from "effect";
import { HttpServer, HttpServerResponse } from "effect/http";
import { ActionRunner } from "../src/action-runner.ts";
import { ActionInputErrorReason } from "../src/errors/action-input-error.ts";
import * as ActionRunnerTest from "../src/testing/action-runner-test.ts";

const githubOutputFile = Effect.fn("githubOutputFile")(function* githubOutputFile() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(yield* fs.makeTempDirectoryScoped(), "output");
  yield* fs.writeFileString(file, "");
  vi.stubEnv("GITHUB_OUTPUT", file);

  return file;
});

const oidcEndpoint = HttpServer.serve(
  Effect.succeed(HttpServerResponse.jsonUnsafe({ value: "eyJ.oidc.jwt" })),
).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the test runner and the live runner", () => {
  it.effect.each([
    ["live", ActionRunner.layer],
    ["test", ActionRunnerTest.make({ inputs: { force: "" } }).layer],
  ] as const)("%s fails a missing required boolean input as InvalidType", ([, runnerLayer]) =>
    Effect.gen(function* () {
      vi.stubEnv("INPUT_FORCE", "");
      const runner = yield* ActionRunner;

      const error = yield* runner.getBooleanInput("force", { required: true }).pipe(Effect.flip);

      expect(error.reason).toBe(ActionInputErrorReason.InvalidType);
      expect(error.name).toBe("force");
    }).pipe(Effect.provide(runnerLayer)),
  );
});

layer(Layer.mergeAll(ActionRunner.layer, NodeServices.layer))("ActionRunner.layer", (it) => {
  it.effect("writes an output to the GITHUB_OUTPUT file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const outputFile = yield* githubOutputFile();
      const runner = yield* ActionRunner;

      yield* runner.setOutput("verdict", "block");

      expect(yield* fs.readFileString(outputFile)).toMatch(
        /^verdict<<(?<delimiter>\S+)\nblock\n\k<delimiter>\n$/u,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("writes a structured output as JSON", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const outputFile = yield* githubOutputFile();
      const runner = yield* ActionRunner;

      yield* runner.setOutput("findings", [{ area: "tax", severity: "warn" }]);

      expect(yield* fs.readFileString(outputFile)).toContain(
        '\n[{"area":"tax","severity":"warn"}]\n',
      );
    }).pipe(Effect.scoped),
  );

  it.effect("fails a required input that was not supplied", () =>
    Effect.gen(function* () {
      vi.stubEnv("INPUT_TOKEN", "");
      const runner = yield* ActionRunner;

      const error = yield* runner.getInput("token", { required: true }).pipe(Effect.flip);

      expect(error.reason).toBe(ActionInputErrorReason.Missing);
      expect(error.message).toBe("Input required and not supplied: token");
    }),
  );

  it.effect("returns the OIDC token redacted", () =>
    Effect.gen(function* () {
      const endpoint = yield* HttpServer.addressFormattedWith((address) => Effect.succeed(address));
      vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_URL", `${endpoint}/token?api-version=2.0`);
      vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "runtime-token");
      const runner = yield* ActionRunner;

      const token = yield* runner.getIDToken("sts.amazonaws.com");

      expect(Redacted.value(token)).toBe("eyJ.oidc.jwt");
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ token }),
      ).not.toContain("eyJ.oidc.jwt");
    }).pipe(Effect.provide(oidcEndpoint)),
  );

  it.effect("reads an input from its INPUT_ variable", () =>
    Effect.gen(function* () {
      vi.stubEnv("INPUT_PR_NUMBER", "  42 ");
      const runner = yield* ActionRunner;

      const prNumber = yield* runner.getInput("pr number");

      expect(prNumber).toBe("42");
    }),
  );

  it.effect("fails a boolean input outside the YAML core schema", () =>
    Effect.gen(function* () {
      vi.stubEnv("INPUT_FORCE", "yes");
      const runner = yield* ActionRunner;

      const error = yield* runner.getBooleanInput("force").pipe(Effect.flip);

      expect(error.reason).toBe(ActionInputErrorReason.InvalidType);
      expect(error.name).toBe("force");
    }),
  );
});
