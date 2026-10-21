import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { Schema } from "effect";
import * as Json from "../src/json.ts";

describe("Json.canonical", () => {
  it("sorts the keys of every object at every depth", () => {
    const nested = Object.fromEntries<Schema.Json>([
      ["d", [true, null]],
      ["c", "x"],
    ]);

    expect(
      Json.canonical(
        Object.fromEntries<Schema.Json>([
          ["b", 1],
          ["a", nested],
        ]),
      ),
    ).toBe('{"a":{"c":"x","d":[true,null]},"b":1}');
  });

  it("gives the same text for objects that differ only in key order", () => {
    expect(
      Json.canonical(
        Object.fromEntries<Schema.Json>([
          ["id", "m1"],
          ["amount", 10],
        ]),
      ),
    ).toBe(Json.canonical({ amount: 10, id: "m1" }));
  });

  it("keeps the order of arrays", () => {
    expect(Json.canonical([2, 1])).not.toBe(Json.canonical([1, 2]));
  });
});

describe("Json.sha256", () => {
  it.effect("gives the hex digest of the text", () =>
    Effect.gen(function* () {
      expect(yield* Json.sha256("abc")).toBe(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      );
    }),
  );

  it.effect("hashes the UTF-8 bytes of the text", () =>
    Effect.gen(function* () {
      expect(yield* Json.sha256("perché")).toBe(
        "6ceb40868331b6aeaf04d231dd8f585ead5144d1da87ea54becec333c7943107",
      );
    }),
  );
});
