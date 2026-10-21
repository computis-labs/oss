import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import * as Privacy from "../src/privacy.ts";

const iban = { name: "iban", pattern: /IT\d{2}[A-Z]\d{10}/u };
const fiscalCode = { name: "fiscal code", pattern: /[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]/u };

const withEnvironment = (env: Record<string, string>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

describe("Privacy.scan", () => {
  it("reports every rule a string matches with its JSON path", () => {
    const findings = Privacy.scan(
      "m1",
      {
        counterparty: { fiscalCode: "RSSMRA80A01H501U" },
        lines: ["BONIFICO IT60X0542811101", "CANONE"],
      },
      { denylist: [], rules: [iban, fiscalCode] },
    );

    expect(findings).toEqual([
      { case: "m1", path: "counterparty.fiscalCode", rule: "fiscal code" },
      { case: "m1", path: "lines[0]", rule: "iban" },
    ]);
  });

  it("matches denylist tokens without regard to case", () => {
    expect(
      Privacy.scan(
        "m2",
        { description: "Pagamento a Mario ROSSI" },
        { denylist: ["rossi"], rules: [] },
      ),
    ).toEqual([{ case: "m2", path: "description", rule: "denylist: rossi" }]);
  });

  it("finds nothing in numbers, booleans and null", () => {
    expect(
      Privacy.scan(
        "m3",
        { amount: 12, note: null, paid: true },
        { denylist: ["12"], rules: [iban] },
      ),
    ).toEqual([]);
  });
});

describe("Privacy.denylist", () => {
  it.effect("splits the variable on commas, trims and lowercases the tokens", () =>
    Effect.gen(function* () {
      const tokens = yield* Privacy.resolveDenylist({
        denylist: Privacy.denylist("EVAL_DENYLIST"),
        rules: [],
      });

      expect(tokens).toEqual(["rossi", "bianchi srl"]);
    }).pipe(withEnvironment({ EVAL_DENYLIST: " Rossi , ,Bianchi SRL" })),
  );

  it.effect("is empty when the variable is not set", () =>
    Effect.gen(function* () {
      const tokens = yield* Privacy.resolveDenylist({
        denylist: Privacy.denylist("EVAL_DENYLIST"),
        rules: [],
      });

      expect(tokens).toEqual([]);
    }).pipe(withEnvironment({})),
  );

  it.effect("is empty when the privacy settings have no denylist", () =>
    Effect.gen(function* () {
      expect(yield* Privacy.resolveDenylist({ rules: [iban] })).toEqual([]);
    }),
  );
});
