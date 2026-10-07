// oxlint-disable-next-line test-boundary/no-test-imports -- the benchmarks are removed before the merge and share the test invoices until then
import { fatturaFixtures } from "../tests/fixtures/fattura.ts";
import type { Baseline } from "./baseline.ts";

export const makeFixtures = (baseline: Baseline) =>
  fatturaFixtures.map(({ fattura, name }) => {
    const xml = baseline.buildDocument("pretty", baseline.encodeFattura(fattura));

    return {
      bytes: new TextEncoder().encode(xml).byteLength,
      fattura,
      name,
      schemaDecode: baseline.prepareSchemaDecode(xml),
      xml,
    };
  });
