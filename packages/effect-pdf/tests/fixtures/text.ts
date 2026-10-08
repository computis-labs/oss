import { A4, assemblePdf, latin1, onePagePdf, pdfStream } from "#effect-pdf/testing";

export const SMILEY_TEXT = "\u{1F600}";

const type3Font = (toUnicode: string) =>
  latin1(
    `<< /Type /Font /Subtype /Type3 /FontBBox [0 0 500 700] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /g1 8 0 R >> /Encoding << /Type /Encoding /Differences [1 /g1] >> /FirstChar 1 /LastChar 1 /Widths [500] /Resources << >>${toUnicode} >>`,
  );

export const unmappedFontPdf = () =>
  assemblePdf([
    latin1("<< /Type /Catalog /Pages 2 0 R >>"),
    latin1("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    latin1(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width.toString()} ${A4.height.toString()}] /Resources << /Font << /T3 5 0 R /E3 6 0 R /F1 7 0 R >> >> /Contents 4 0 R >>`,
    ),
    pdfStream(
      "",
      latin1(
        "BT /E3 12 Tf 50 700 Td (\u0001) Tj ET BT /F1 12 Tf 100 700 Td (Firma SIGFIELD:cliente-0-1) Tj ET BT /T3 12 Tf 50 650 Td (\u0001\u0001\u0001) Tj ET",
      ),
    ),
    type3Font(""),
    type3Font(" /ToUnicode 9 0 R"),
    latin1("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    pdfStream("", latin1("500 0 0 0 400 700 d1 0 0 400 700 re f")),
    pdfStream(
      "",
      latin1(
        "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Smiley def 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <01> <D83DDE00> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end",
      ),
    ),
  ]);

export const emptyPdf = () => onePagePdf("", {});

export interface PlacedText {
  readonly pieces?: readonly string[];
  readonly rotated?: boolean;
  readonly size?: number;
  readonly text: string;
  readonly x: number;
  readonly y: number;
}

export const placedTextPdf = (cells: readonly PlacedText[]) =>
  onePagePdf(
    cells
      .flatMap((cell) => [
        "BT",
        `/F1 ${(cell.size ?? 10).toString()} Tf`,
        `${cell.rotated === true ? "0 1 -1 0" : "1 0 0 1"} ${cell.x.toString()} ${cell.y.toString()} Tm`,
        ...(cell.pieces ?? [cell.text]).map((piece) => `(${piece}) Tj`),
        "ET",
      ])
      .join("\n"),
    {},
  );

export const rotatedTokenPdf = () =>
  assemblePdf([
    latin1("<< /Type /Catalog /Pages 2 0 R >>"),
    latin1("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    latin1(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate 90 /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    ),
    pdfStream("", latin1("BT /F1 4 Tf 72 600 Td (SIGFIELD:cliente-0-0) Tj ET")),
    latin1("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
  ]);
