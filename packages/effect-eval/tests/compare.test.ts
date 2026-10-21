import { describe, expect, it } from "@effect/vitest";
import { BigDecimal, Equivalence } from "effect";
import * as Agreement from "../src/agreement.ts";
import * as Compare from "../src/compare.ts";

const scoreOf = (agreement: Agreement.Agreement) => Agreement.credit(agreement);

describe("Compare.exact", () => {
  it("agrees on equal values and disagrees on different ones", () => {
    const compare = Compare.exact<string>();

    expect([compare("IT01234567890", "IT01234567890"), compare("IT01234567890", "IT0")]).toEqual([
      Agreement.exact,
      Agreement.different,
    ]);
  });

  it("uses the equivalence it receives", () => {
    const compare = Compare.exact(
      Equivalence.mapInput(Equivalence.String, (text: string) => text.toLowerCase()),
    );

    expect(compare("Rossi", "ROSSI")).toEqual(Agreement.exact);
  });
});

describe("Compare.normalizedText", () => {
  it("ignores case, outer spaces and repeated inner spaces", () => {
    expect(Compare.normalizedText()("  Via  Roma 1 ", "via roma 1")).toEqual(Agreement.exact);
  });

  it("disagrees when the words differ", () => {
    expect(Compare.normalizedText()("Via Roma 1", "Via Roma 2")).toEqual(Agreement.different);
  });
});

describe("Compare.tolerance", () => {
  it("agrees on amounts within the tolerance and disagrees beyond it", () => {
    const compare = Compare.tolerance(BigDecimal.fromStringUnsafe("0.01"));

    expect([
      compare(BigDecimal.fromStringUnsafe("100.00"), BigDecimal.fromStringUnsafe("100.01")),
      compare(BigDecimal.fromStringUnsafe("100.00"), BigDecimal.fromStringUnsafe("100.02")),
    ]).toEqual([Agreement.exact, Agreement.different]);
  });
});

describe("Compare.numericTolerance", () => {
  it("compares the absolute difference by default", () => {
    const compare = Compare.numericTolerance(0.5);

    expect([compare(10, 10.5), compare(10, 10.6)]).toEqual([Agreement.exact, Agreement.different]);
  });

  it("scales the tolerance by the expected value when relative", () => {
    const compare = Compare.numericTolerance(0.1, { relative: true });

    expect([compare(200, 219), compare(200, 221)]).toEqual([Agreement.exact, Agreement.different]);
  });
});

describe("Compare.similarity", () => {
  it("gives a partial agreement from the normalized Levenshtein distance", () => {
    expect(scoreOf(Compare.similarity()("ROSSI", "ROSSO"))).toBeCloseTo(0.8);
  });

  it("agrees exactly on texts equal after normalization", () => {
    expect(Compare.similarity()("Bianchi Srl", "BIANCHI SRL")).toEqual(Agreement.exact);
  });

  it("disagrees on texts with nothing in common", () => {
    expect(Compare.similarity()("ABC", "XYZ")).toEqual(Agreement.different);
  });
});

describe("Compare.levenshteinRatio", () => {
  it("counts code points, so an accented letter is one edit", () => {
    expect(Compare.levenshteinRatio("perché", "perche")).toBeCloseTo(5 / 6);
  });

  it("treats two empty texts as identical", () => {
    expect(Compare.levenshteinRatio("", "")).toBe(1);
  });
});

describe("Compare.tokenSimilarity", () => {
  it("agrees when the expected name is contained in the actual one", () => {
    expect(Compare.tokenSimilarity()("Bianchi Software", "Bianchi Software S.r.l.")).toEqual(
      Agreement.exact,
    );
  });

  it("ignores accents and punctuation", () => {
    expect(Compare.tokenSimilarity()("Caffè Nerò", "CAFFE' NERO")).toEqual(Agreement.exact);
  });

  it("treats a name glued into one word as contained in the spaced one", () => {
    expect(Compare.tokenSimilarity()("BianchiSoftware", "Bianchi Software Srl")).toEqual(
      Agreement.exact,
    );
  });

  it("falls back to the compact similarity when the name is shorter than minContained", () => {
    const agreement = Compare.tokenSimilarity({ minContained: 20 })(
      "BianchiSoftware",
      "Bianchi Software Srl",
    );

    expect(scoreOf(agreement)).toBeCloseTo(15 / 18);
  });

  it("gives partial credit when only some of the expected words match", () => {
    const score = scoreOf(Compare.tokenSimilarity()("Mario Rossi", "Mario Bianchi"));

    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThan(1);
  });
});

describe("Compare.subset", () => {
  const compare = Compare.subset(Equivalence.String);

  it("agrees when both sides hold the same items in any order", () => {
    expect(compare(["INV-1", "INV-2"], ["INV-2", "INV-1"])).toEqual(Agreement.exact);
  });

  it("gives partial credit for a non empty subset of the expected items", () => {
    expect(compare(["INV-1", "INV-2", "INV-3"], ["INV-1"])).toEqual(Agreement.partial(1 / 3));
  });

  it("disagrees when the actual side has an item that was not expected", () => {
    expect(compare(["INV-1", "INV-2"], ["INV-1", "INV-9"])).toEqual(Agreement.different);
  });

  it("disagrees when the actual side is empty", () => {
    expect(compare(["INV-1"], [])).toEqual(Agreement.different);
  });

  it("agrees on two empty sets, which are equal", () => {
    expect(compare([], [])).toEqual(Agreement.exact);
  });

  it("counts a repeated item once", () => {
    expect(compare(["INV-1", "INV-2"], ["INV-1", "INV-1"])).toEqual(Agreement.partial(1 / 2));
  });
});

describe("Compare.custom and Compare.mapInput", () => {
  it("compares a field read from a record with a custom comparator", () => {
    const compare = Compare.mapInput((supplier: { readonly vat: string }) => supplier.vat)(
      Compare.custom<string>((expected, actual) =>
        expected === actual ? Agreement.exact : Agreement.partial(0.5),
      ),
    );

    expect([
      compare({ vat: "IT1" }, { vat: "IT1" }),
      compare({ vat: "IT1" }, { vat: "IT2" }),
    ]).toEqual([Agreement.exact, Agreement.partial(0.5)]);
  });
});
