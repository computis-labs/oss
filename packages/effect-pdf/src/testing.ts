import * as Arr from "effect/Array";

export const A4 = { height: 842, width: 595 } as const;

export const latin1 = (value: string) =>
  Uint8Array.from(value, (character) => character.codePointAt(0) ?? 0);

const concat = (parts: readonly Uint8Array[]) =>
  Uint8Array.from(parts.flatMap((part) => [...part]));

export const pdfStream = (dictionary: string, data: Uint8Array) =>
  concat([
    latin1(`<< ${dictionary} /Length ${data.length.toString()} >>\nstream\n`),
    data,
    latin1("\nendstream"),
  ]);

const RUN_LENGTH_MAX_REPEAT = 128;
const RUN_LENGTH_END = 128;
const RUN_LENGTH_REPEAT_BASE = 257;

export const assemblePdf = (objects: readonly Uint8Array[]) => {
  const header = latin1("%PDF-1.7\n");
  const chunks = objects.map((body, index) =>
    concat([latin1(`${(index + 1).toString()} 0 obj\n`), body, latin1("\nendobj\n")]),
  );
  const offsets = Arr.scan(chunks, header.length, (position, chunk) => position + chunk.length);
  const table = [
    "xref",
    `0 ${(objects.length + 1).toString()}`,
    "0000000000 65535 f ",
    ...offsets.slice(0, -1).map((offset) => `${offset.toString().padStart(10, "0")} 00000 n `),
  ].join("\n");
  return concat([
    header,
    ...chunks,
    latin1(
      `${table}\ntrailer\n<< /Size ${(objects.length + 1).toString()} /Root 1 0 R >>\nstartxref\n${(offsets.at(-1) ?? 0).toString()}\n%%EOF\n`,
    ),
  ]);
};

export const onePagePdf = (
  content: string,
  xobjects: Readonly<Record<string, Uint8Array>> = {},
) => {
  const names = Object.keys(xobjects);
  const fontNumber = 5 + names.length;
  const xobjectRefs = names
    .map((name, index) => `/${name} ${(5 + index).toString()} 0 R`)
    .join(" ");
  return assemblePdf([
    latin1("<< /Type /Catalog /Pages 2 0 R >>"),
    latin1("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    latin1(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width.toString()} ${A4.height.toString()}] /Resources << /XObject << ${xobjectRefs} >> /Font << /F1 ${fontNumber.toString()} 0 R >> >> /Contents 4 0 R >>`,
    ),
    pdfStream("", latin1(content)),
    ...Object.values(xobjects),
    latin1("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
  ]);
};

const BILEVEL_WIDTH = 144;
const BILEVEL_HEIGHT = 200;
const BILEVEL_ROW_BYTES = Math.ceil(BILEVEL_WIDTH / 8);

export const bilevelScan = {
  height: BILEVEL_HEIGHT,
  rows: Uint8Array.from({ length: BILEVEL_ROW_BYTES * BILEVEL_HEIGHT }, (_, index) =>
    Math.floor(index / BILEVEL_ROW_BYTES) < BILEVEL_HEIGHT / 2 &&
    (index % BILEVEL_ROW_BYTES) % 2 === 0
      ? 0x0f
      : 0xff,
  ),
  width: BILEVEL_WIDTH,
} as const;

export const bilevelImage = () =>
  pdfStream(
    `/Type /XObject /Subtype /Image /Width ${bilevelScan.width.toString()} /Height ${bilevelScan.height.toString()} /ColorSpace /DeviceGray /BitsPerComponent 1`,
    bilevelScan.rows,
  );

export const fullPage = (name: string) =>
  `q ${A4.width.toString()} 0 0 ${A4.height.toString()} 0 0 cm /${name} Do Q\n`;

const textAt = (text: string, renderingMode: number) =>
  `BT ${renderingMode.toString()} Tr /F1 12 Tf 50 700 Td (${text}) Tj ET\n`;

const HIDDEN = 3;
const VISIBLE = 0;

export const scanPdf = ({
  hiddenText,
  visibleText,
}: { readonly hiddenText?: string; readonly visibleText?: string } = {}) =>
  onePagePdf(
    [
      fullPage("Scan"),
      ...(hiddenText === undefined ? [] : [textAt(hiddenText, HIDDEN)]),
      ...(visibleText === undefined ? [] : [textAt(visibleText, VISIBLE)]),
    ].join(""),
    { Scan: bilevelImage() },
  );

export const scanPageKinds = {
  form: "form",
  inline: "inline",
  oversized: "oversized",
  picture: "picture",
  searchable: "searchable",
  strips: "strips",
} as const;
export type ScanPageKind = (typeof scanPageKinds)[keyof typeof scanPageKinds];

const OVERSIZED_SIDE = 4224;
const OVERSIZED_RUNS = (OVERSIZED_SIDE * OVERSIZED_SIDE) / RUN_LENGTH_MAX_REPEAT;
const WHITE = 255;
const pagePlacement = `${A4.width.toString()} 0 0 ${A4.height.toString()} 0 0 cm`;
const halfHeight = (A4.height / 2).toString();
const ocrLines = Array.from(
  { length: 5 },
  (_, index) => `Riga ${(index + 1).toString()} del testo letto dallo scanner sotto l'immagine`,
);

const scanContent = {
  form: latin1("/Fm1 Do"),
  inline: concat([
    latin1(`q ${pagePlacement} BI /W 1 /H 1 /CS /G /BPC 8 ID `),
    Uint8Array.of(WHITE),
    latin1("\nEI Q"),
  ]),
  oversized: latin1(`q ${pagePlacement} /Big Do Q`),
  picture: latin1(`q ${pagePlacement} /Im1 Do Q`),
  searchable: latin1(
    [
      `q ${pagePlacement} /Im1 Do Q`,
      "BT 3 Tr /F1 11 Tf 12 TL",
      `1 0 0 1 40 ${(A4.height - 60).toString()} Tm`,
      ...ocrLines.map((line) => `(${line}) Tj T*`),
      "ET",
    ].join("\n"),
  ),
  strips: latin1(
    `q ${A4.width.toString()} 0 0 ${halfHeight} 0 0 cm /Im1 Do Q\n` +
      `q ${A4.width.toString()} 0 0 ${halfHeight} 0 ${halfHeight} cm /Im1 Do Q`,
  ),
} satisfies Record<ScanPageKind, Uint8Array>;

export const scansPdf = (pages: readonly ScanPageKind[]) => {
  const firstPage = 7;
  const kids = pages.map((_, index) => `${(firstPage + index * 2).toString()} 0 R`).join(" ");
  return assemblePdf([
    latin1("<< /Type /Catalog /Pages 2 0 R >>"),
    latin1(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length.toString()} >>`),
    pdfStream(
      "/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8",
      Uint8Array.of(WHITE),
    ),
    pdfStream(
      `/Type /XObject /Subtype /Form /BBox [0 0 1 1] /Matrix [${pagePlacement.replace(" cm", "")}] /Resources << /XObject << /Im1 3 0 R >> >>`,
      latin1("/Im1 Do"),
    ),
    pages.includes(scanPageKinds.oversized)
      ? pdfStream(
          `/Type /XObject /Subtype /Image /Width ${OVERSIZED_SIDE.toString()} /Height ${OVERSIZED_SIDE.toString()} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /RunLengthDecode`,
          Uint8Array.from([
            ...Array.from({ length: OVERSIZED_RUNS }, () => [
              RUN_LENGTH_REPEAT_BASE - RUN_LENGTH_MAX_REPEAT,
              0,
            ]).flat(),
            RUN_LENGTH_END,
          ]),
        )
      : latin1("null"),
    latin1("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    ...pages.flatMap((page, index) => [
      latin1(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width.toString()} ${A4.height.toString()}] /Resources << /XObject << /Im1 3 0 R /Fm1 4 0 R /Big 5 0 R >> /Font << /F1 6 0 R >> >> /Contents ${(firstPage + index * 2 + 1).toString()} 0 R >>`,
      ),
      pdfStream("", scanContent[page]),
    ]),
  ]);
};
