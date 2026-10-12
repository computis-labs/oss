import { NodeServices } from "@effect/platform-node";
import { afterEach, describe, expect, it, layer, vi } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { ActionSummary } from "../src/action-summary.ts";
import * as ActionSummaryTest from "../src/testing/action-summary-test.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

layer(Layer.mergeAll(ActionSummary.layer, NodeServices.layer))("ActionSummary.layer", (it) => {
  it.effect("appends the summary to the GITHUB_STEP_SUMMARY file and empties the buffer", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const summaryFile = path.join(yield* fs.makeTempDirectoryScoped(), "summary");
      yield* fs.writeFileString(summaryFile, "previous step\n");
      vi.stubEnv("GITHUB_STEP_SUMMARY", summaryFile);
      const summary = yield* ActionSummary;

      const written = yield* summary
        .addHeading("Legal review", 2)
        .addTable([[{ data: "Area", header: true }], [{ data: "Fisco" }]])
        .write();

      expect(yield* fs.readFileString(summaryFile)).toBe(
        "previous step\n<h2>Legal review</h2>\n<table><tr><th>Area</th></tr><tr><td>Fisco</td></tr></table>\n",
      );
      expect(written.isEmptyBuffer()).toBe(true);
    }).pipe(Effect.scoped),
  );
});

describe("ActionSummaryTest", () => {
  it.effect("renders the builder calls and empties on request", () => {
    const fake = ActionSummaryTest.make();
    return Effect.gen(function* () {
      const summary = yield* ActionSummary;

      summary.addHeading("Legal review", 3).addList(["Fisco", "Dati"]);
      const rendered = fake.getBuffer();
      const emptied = summary.emptyBuffer();

      expect(rendered).toBe("<h3>Legal review</h3>\n<ul><li>Fisco</li><li>Dati</li></ul>\n");
      expect(emptied.isEmptyBuffer()).toBe(true);
      expect(fake.getBuffer()).toBe("");
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("fails the write it was told to fail", () =>
    Effect.gen(function* () {
      const summary = yield* ActionSummary;

      const error = yield* summary.addRaw("body").write().pipe(Effect.flip);

      expect(error.message).toBe("Failed to write job summary: disk full");
    }).pipe(Effect.provide(ActionSummaryTest.make({ writeError: "disk full" }).layer)),
  );
});
