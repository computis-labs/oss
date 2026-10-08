import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { pdfEngineLayer } from "./fixtures/layer.ts";
import { placedTextPdf } from "./fixtures/text.ts";
import type { PlacedText } from "./fixtures/text.ts";
import { open } from "#effect-pdf/index";

const ROW_Y = 600;

const header: readonly PlacedText[] = [
  "Fornitore di Prova - Via Inventata 1, 00000 Nessun Luogo",
  "Fattura 42 del 10 marzo 2026 - valuta EUR",
].map((text, index) => ({ text, x: 40, y: 740 - index * 14 }));

const tableRow: readonly PlacedText[] = [
  { text: "36,00", x: 540, y: ROW_Y },
  { text: "4,5000", x: 420, y: ROW_Y },
  { text: "0", x: 500, y: ROW_Y },
  { text: "101", x: 40, y: ROW_Y },
  { text: "ARTICOLO DI PROVA", x: 80, y: ROW_Y },
  { text: "12,00", x: 370, y: ROW_Y },
  { size: 8, text: "1,23", x: 460, y: ROW_Y + 1.112 },
  { text: "3", x: 340, y: ROW_Y },
];

const TABLE_LINE = "101 ARTICOLO DI PROVA 3 12,00 4,5000 1,23 0 36,00";

const layoutLines = (cells: readonly PlacedText[]) =>
  Effect.gen(function* () {
    const document = yield* open(placedTextPdf(cells));
    const [page] = yield* document.text({ layout: true });
    return (page?.text ?? "").split("\n").map((line) => line.replaceAll(/\s+/gu, " ").trim());
  });

layer(pdfEngineLayer)("text with layout", (it) => {
  it.effect("keeps the cells of a table row apart and in reading order", () =>
    Effect.gen(function* () {
      const lines = yield* layoutLines([...header, ...tableRow]);

      expect(lines.filter((line) => line.startsWith("101 "))).toStrictEqual([TABLE_LINE]);
      expect(lines.slice(0, 2)).toStrictEqual(header.map(({ text }) => text));
    }),
  );

  it.effect("spaces the cells of a row by the gap between them", () =>
    Effect.gen(function* () {
      const document = yield* open(placedTextPdf(tableRow));

      const [page] = yield* document.text({ layout: true });

      expect(page?.text).toMatch(/^101 {2,4}ARTICOLO DI PROVA {2,4}3 {2,4}12,00/u);
    }),
  );

  it.effect("does not chain a row into the next one through text of growing size", () =>
    Effect.gen(function* () {
      const lines = yield* layoutLines([
        { size: 8, text: "ALFA", x: 40, y: 500 },
        { size: 10, text: "BETA", x: 200, y: 497 },
        { size: 12, text: "GAMMA", x: 400, y: 493 },
      ]);

      expect(lines).toStrictEqual(["ALFA BETA", "GAMMA"]);
    }),
  );

  it.effect("keeps a word written in several pieces whole", () =>
    Effect.gen(function* () {
      const lines = yield* layoutLines([
        { pieces: ["FAT", "TURA"], text: "FATTURA", x: 40, y: 500 },
      ]);

      expect(lines).toStrictEqual(["FATTURA"]);
    }),
  );

  it.effect("writes text drawn twice for a bold effect once", () =>
    Effect.gen(function* () {
      const lines = yield* layoutLines([
        { text: "TOTALE", x: 40, y: 500 },
        { text: "TOTALE", x: 40.3, y: 500 },
      ]);

      expect(lines).toStrictEqual(["TOTALE"]);
    }),
  );

  it.effect("puts a rotated margin note after the rows without breaking them", () =>
    Effect.gen(function* () {
      const lines = yield* layoutLines([
        ...header,
        { rotated: true, text: "Nota a margine ruotata", x: 20, y: 300 },
        ...tableRow,
      ]);

      expect(lines.at(-1)).toBe("Nota a margine ruotata");
      expect(lines).toContain(TABLE_LINE);
    }),
  );

  it.effect("returns nothing for a page without text", () =>
    Effect.gen(function* () {
      const lines = yield* layoutLines([]);

      expect(lines).toStrictEqual([""]);
    }),
  );
});
