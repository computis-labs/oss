import { describe, expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { pdfEngineLayer } from "./fixtures/layer.ts";
import { SIGNATURE_TOKEN, textPdf } from "./fixtures/forms.ts";
import { logoInvoicePdf } from "./fixtures/scans.ts";
import { SMILEY_TEXT, rotatedTokenPdf, emptyPdf, unmappedFontPdf } from "./fixtures/text.ts";
import { PdfOpenError, pdfOpenFailures } from "../src/errors/pdf-open-error.ts";
import { PdfPageError } from "../src/errors/pdf-page-error.ts";
import { PdfEngine } from "../src/engine.ts";
import { open } from "../src/index.ts";
import { A4, scanPdf, scansPdf, scanPageKinds } from "../src/testing.ts";
import { pdfPageKinds } from "../src/types.ts";

layer(pdfEngineLayer)("open", (it) => {
  it.effect("reads the page count and the size of every page", () =>
    Effect.gen(function* () {
      const document = yield* open(yield* textPdf([["Uno"], ["Due"]]));

      expect(document.pageCount).toBe(2);
      expect(document.pages).toStrictEqual([
        { height: A4.height, index: 0, rotation: 0, width: A4.width },
        { height: A4.height, index: 1, rotation: 0, width: A4.width },
      ]);
    }),
  );

  it.effect("reports a turned page in the same space as the coordinates it returns", () =>
    Effect.gen(function* () {
      const document = yield* open(rotatedTokenPdf());

      const [match] = yield* document.find(/SIGFIELD/u);

      expect(document.pages).toStrictEqual([{ height: 792, index: 0, rotation: 90, width: 612 }]);
      expect(match?.origin).toStrictEqual({ x: 72, y: 600 });
    }),
  );

  it.effect("opens a document through the engine a service holds", () =>
    Effect.gen(function* () {
      const engine = yield* PdfEngine;

      const document = yield* engine.open(scanPdf());

      expect(document.pageCount).toBe(1);
    }),
  );

  it.effect("fails bytes that are not a PDF with the format reason", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(open(new TextEncoder().encode("not a pdf")));

      expect(error).toBeInstanceOf(PdfOpenError);
      expect(error).toMatchObject({ reason: pdfOpenFailures.format });
    }),
  );

  it.effect("opens and closes many documents in a row without leaking engine memory", () =>
    Effect.gen(function* () {
      const bytes = scanPdf();
      yield* Effect.forEach(
        Array.from({ length: 200 }, (_, index) => index),
        () => Effect.scoped(Effect.flatMap(open(bytes), (document) => document.classify)),
        { discard: true },
      );
    }),
  );

  it.effect("rejects a page outside the document", () =>
    Effect.gen(function* () {
      const document = yield* open(scanPdf());

      const error = yield* Effect.flip(document.text({ pages: [1] }));

      expect(error).toStrictEqual(PdfPageError.outOfRange(1, 1));
    }),
  );
});

describe("classify", () => {
  layer(pdfEngineLayer)((it) => {
    it.effect.each([
      ["text", textPdf([["Fattura n. 7"]]), pdfPageKinds.text],
      ["bilevel scan", Effect.succeed(scanPdf()), pdfPageKinds.image],
      [
        "scan with a hidden OCR layer",
        Effect.succeed(scanPdf({ hiddenText: "Testo OCR nascosto" })),
        pdfPageKinds.image,
      ],
      [
        "scan with a visible stamp",
        Effect.succeed(scanPdf({ visibleText: "Timbro visibile" })),
        pdfPageKinds.mixed,
      ],
      ["digital invoice with a small logo", Effect.succeed(logoInvoicePdf()), pdfPageKinds.text],
      [
        "image placed by a form matrix",
        Effect.succeed(scansPdf([scanPageKinds.form])),
        pdfPageKinds.image,
      ],
      ["empty page", Effect.succeed(emptyPdf()), pdfPageKinds.empty],
    ] as const)("classifies a %s", ([, bytes, kind]) =>
      Effect.gen(function* () {
        const document = yield* open(yield* bytes);

        const classification = yield* document.classify;

        expect(classification.kind).toBe(kind);
      }),
    );

    it.effect("reports hidden text and the image coverage of an OCR scan", () =>
      Effect.gen(function* () {
        const document = yield* open(scanPdf({ hiddenText: "Testo OCR nascosto" }));

        const { pages } = yield* document.classify;

        expect(pages).toStrictEqual([
          { hiddenText: true, imageCoverage: 1, kind: pdfPageKinds.image, visibleText: false },
        ]);
      }),
    );
  });
});

layer(pdfEngineLayer)("text", (it) => {
  it.effect("extracts the text of each page in reading order", () =>
    Effect.gen(function* () {
      const document = yield* open(
        yield* textPdf([["Fattura n. 7", "Totale 1.506,16 €"], ["Pagina due"]]),
      );

      const pages = yield* document.text();

      expect(pages.map(({ page }) => page)).toStrictEqual([0, 1]);
      expect(pages[0]?.text).toContain("Fattura n. 7\nTotale 1.506,16 €");
      expect(pages[1]?.text).toContain("Pagina due");
      expect(pages.every(({ unicodeMapErrors }) => unicodeMapErrors === 0)).toBe(true);
    }),
  );

  it.effect("counts the characters of a font that has no Unicode mapping", () =>
    Effect.gen(function* () {
      const document = yield* open(unmappedFontPdf());

      const [page] = yield* document.text();

      expect(page?.unicodeMapErrors).toBe(3);
      expect(page?.text).toContain(`${SMILEY_TEXT} Firma SIGFIELD:cliente-0-1`);
    }),
  );

  it.effect("places a match that follows a character outside the basic plane", () =>
    Effect.gen(function* () {
      const document = yield* open(unmappedFontPdf());

      const [match] = yield* document.find(/SIGFIELD/u);
      const [beforeIt] = yield* document.find(/Firma/u);

      expect(match?.text).toBe("SIGFIELD");
      expect(match?.box.left).toBeGreaterThan(beforeIt?.box.right ?? Number.POSITIVE_INFINITY);
      expect(match?.box.bottom).toBeCloseTo(beforeIt?.box.bottom ?? 0, 0);
    }),
  );

  it.effect("reads only the selected pages", () =>
    Effect.gen(function* () {
      const document = yield* open(yield* textPdf([["Uno"], ["Due"]]));

      const pages = yield* document.text({ pages: [1] });

      expect(pages.map(({ page }) => page)).toStrictEqual([1]);
    }),
  );

  it.effect("finds a pattern with its groups and its box on the page", () =>
    Effect.gen(function* () {
      const document = yield* open(yield* textPdf([["Contratto"]]));

      const [match, ...rest] = yield* document.find(/SIGFIELD:(?<name>[a-z]+(?:-\d+)+)/u);

      expect(rest).toStrictEqual([]);
      expect(match?.groups).toStrictEqual({ name: "cliente-0-1" });
      expect(match?.page).toBe(0);
      expect(match?.box.left).toBeCloseTo(SIGNATURE_TOKEN.x, 0);
      expect(match?.box.bottom).toBeGreaterThanOrEqual(SIGNATURE_TOKEN.y - 1);
      expect(match?.box.top).toBeLessThanOrEqual(SIGNATURE_TOKEN.y + 4);
      expect(match?.origin.x).toBeCloseTo(SIGNATURE_TOKEN.x, 3);
      expect(match?.origin.y).toBeCloseTo(SIGNATURE_TOKEN.y, 3);
    }),
  );
});
