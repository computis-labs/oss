/* oxlint-disable sort-keys -- XML is sequence-typed: the Struct field order is the element order under test, so sorting the keys changes the documents. */
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { Effect } from "effect";
import { runDocumento } from "./fixtures/jit-documento.ts";

describe("codec with the Schema JIT", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.effect("compiles the codec Schema into generated functions and round-trips the document", () =>
    Effect.gen(function* test() {
      const spy = vi.spyOn(globalThis, "Function");

      const { documento, written } = yield* runDocumento(true);

      expect(spy.mock.calls.length).toBeGreaterThan(0);
      expect(documento).toStrictEqual({
        Titolo: "Offerta",
        Righe: [{ Codice: "A1", Quantita: 2 }],
      });
      expect(written).toBe(
        '<?xml version="1.0" encoding="UTF-8"?><Documento><Titolo>Offerta</Titolo><Righe><Codice>A1</Codice><Quantita>2</Quantita></Righe></Documento>',
      );
    }),
  );
});
