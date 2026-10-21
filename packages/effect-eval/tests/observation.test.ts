import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Result, Schema, pipe } from "effect";
import * as Agreement from "../src/agreement.ts";
import * as Observation from "../src/observation.ts";
import { actualStates, expectedStates } from "../src/observation.ts";

const observation = Observation.compared({
  agreement: Agreement.partial(0.5),
  detail: { actual: "Rossi Srl", expected: "Rossi S.r.l.", note: "supplier name" },
  key: "denominazione",
  tags: ["group:supplier"],
});

describe("Observation.compared", () => {
  it("records two present sides and their agreement", () => {
    expect(observation).toMatchObject({
      actual: actualStates.present,
      agreement: Option.some(Agreement.partial(0.5)),
      expected: expectedStates.present,
      failure: Option.none(),
      gap: Option.none(),
    });
  });
});

describe("Observation.errored", () => {
  it("records the failure, an absent actual side and the expectation", () => {
    expect(
      Observation.errored("natura", "timeout after 180 s", {
        expected: expectedStates.unknown,
        tags: ["month:2025-03"],
      }),
    ).toMatchObject({
      actual: actualStates.absent,
      detail: { actual: "", expected: "" },
      expected: expectedStates.unknown,
      failure: Option.some("timeout after 180 s"),
      tags: ["month:2025-03"],
    });
  });
});

describe("Observation.knownGap, exclude and tagged", () => {
  it("adds a gap, an exclusion and tags without touching the rest", () => {
    const changed = pipe(
      observation,
      Observation.knownGap("no reference"),
      Observation.exclude("convention"),
      Observation.tagged("bank:intesa"),
    );

    expect(changed).toEqual({
      ...observation,
      excluded: Option.some("convention"),
      gap: Option.some("no reference"),
      tags: ["group:supplier", "bank:intesa"],
    });
  });
});

describe("ObservationSchema", () => {
  it.effect("encodes the optional fields as null and decodes them back", () =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(Observation.ObservationSchema)(observation);
      const decoded = yield* Schema.decodeUnknownEffect(Observation.ObservationSchema)(encoded);

      expect(encoded).toMatchObject({ excluded: null, failure: null, gap: null });
      expect(decoded).toEqual(observation);
    }),
  );

  const stored = {
    actual: "present",
    agreement: null,
    detail: { actual: "N6.3", expected: "N6.3" },
    excluded: null,
    expected: "present",
    failure: null,
    gap: null,
    key: "natura",
    tags: [],
  };

  it("rejects two present sides without an agreement", () => {
    expect(
      Result.isFailure(Schema.decodeUnknownResult(Observation.ObservationSchema)(stored)),
    ).toBe(true);
  });

  it("rejects an agreement when a side is absent", () => {
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(Observation.ObservationSchema)({
          ...stored,
          actual: "absent",
          agreement: { _tag: "Exact" },
        }),
      ),
    ).toBe(true);
  });

  it("rejects a failure with an actual value", () => {
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(Observation.ObservationSchema)({
          ...stored,
          agreement: { _tag: "Exact" },
          failure: "timeout",
        }),
      ),
    ).toBe(true);
  });
});

describe("Observation.ObservationSchema.make", () => {
  it("rejects two present sides, which need an agreement", () => {
    expect(() =>
      Observation.ObservationSchema.make({
        actual: actualStates.present,
        agreement: Option.none(),
        detail: { actual: "N6.3", expected: "N6.3" },
        excluded: Option.none(),
        expected: expectedStates.present,
        failure: Option.none(),
        gap: Option.none(),
        key: "natura",
        tags: [],
      }),
    ).toThrow();
  });
});

describe("Observation.make", () => {
  it("accepts a correct abstention", () => {
    expect(
      Observation.make({
        actual: actualStates.absent,
        detail: { actual: "—", expected: "—" },
        expected: expectedStates.absent,
        key: "natura",
      }).agreement,
    ).toEqual(Option.none());
  });
});

const TRICKY = Schema.Literals(["", "/", "\\", "a", "b", "a/b", "a\\/b", "\\/", "\\_"]);

const encode = (sub: string, key: string) =>
  Observation.within(sub, key === "" ? Observation.rootKey : Observation.keyOf(key));

describe("Observation keys", () => {
  it("keeps the case itself, an empty segment and a segment with a slash apart", () => {
    expect([
      Observation.rootKey,
      Observation.keyOf(""),
      Observation.keyOf("a/b"),
      Observation.within("a", Observation.keyOf("b")),
      Observation.within("a/b", Observation.rootKey),
      Observation.within("", Observation.rootKey),
    ]).toEqual(["", "\\_", "a\\/b", "a/b", "a\\/b", "\\_"]);
  });

  it.prop(
    "gives two keys within a sub-case the same text only when sub-case and inner key are the same",
    { first: Schema.Tuple([TRICKY, TRICKY]), second: Schema.Tuple([TRICKY, TRICKY]) },
    ({ first: [firstCase, firstKey], second: [secondCase, secondKey] }) => {
      expect(encode(firstCase, firstKey) === encode(secondCase, secondKey)).toBe(
        firstCase === secondCase && firstKey === secondKey,
      );
    },
  );
});
