import { deflateSync } from "node:zlib";
import { Array as Arr, Data, Effect, FileSystem, Path } from "effect";
import { PDFDocument, StandardFonts } from "pdf-lib";

export const PAGE = { height: 842, width: 595 } as const;
export const SCAN = { height: 200, width: 144 } as const;

export class FixtureError extends Data.TaggedError("FixtureError")<{ readonly cause: unknown }> {
  readonly code = "FIXTURE";
}

export const fixture = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ catch: (cause) => new FixtureError({ cause }), try: run });

const readFixture = (name: string) =>
  Effect.gen(function* readFixtureFile() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const bytes = yield* fs.readFile(yield* path.fromFileUrl(new URL(name, import.meta.url)));
    return new Uint8Array(bytes);
  });

export const scanJpeg = readFixture("scan.jpg");

const latin1 = (value: string) => Buffer.from(value, "latin1");

const stream = (dictionary: string, data: Uint8Array) =>
  Buffer.concat([
    latin1(`<< ${dictionary} /Length ${data.length.toString()} >>\nstream\n`),
    data,
    latin1("\nendstream"),
  ]);

const assemble = (objects: readonly Buffer[]) => {
  const header = latin1("%PDF-1.7\n");
  const chunks = objects.map((body, index) =>
    Buffer.concat([latin1(`${(index + 1).toString()} 0 obj\n`), body, latin1("\nendobj\n")]),
  );
  const offsets = Arr.scan(chunks, header.length, (position, chunk) => position + chunk.length);
  const table = [
    "xref",
    `0 ${(objects.length + 1).toString()}`,
    "0000000000 65535 f ",
    ...offsets.slice(0, -1).map((offset) => `${offset.toString().padStart(10, "0")} 00000 n `),
  ].join("\n");
  return new Uint8Array(
    Buffer.concat([
      header,
      ...chunks,
      latin1(
        `${table}\ntrailer\n<< /Size ${(objects.length + 1).toString()} /Root 1 0 R >>\nstartxref\n${(offsets.at(-1) ?? 0).toString()}\n%%EOF\n`,
      ),
    ]),
  );
};

const pageTree = (resources: string, content: string) => [
  latin1("<< /Type /Catalog /Pages 2 0 R >>"),
  latin1("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
  latin1(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width.toString()} ${PAGE.height.toString()}] /Resources << ${resources} >> /Contents 4 0 R >>`,
  ),
  stream("", latin1(content)),
];

const onePage = (content: string, xobjects: Readonly<Record<string, Buffer>>) => {
  const names = Object.keys(xobjects);
  const fontNumber = 5 + names.length;
  const xobjectRefs = names
    .map((name, index) => `/${name} ${(5 + index).toString()} 0 R`)
    .join(" ");
  return assemble([
    ...pageTree(
      `/XObject << ${xobjectRefs} >> /Font << /F1 ${fontNumber.toString()} 0 R >>`,
      content,
    ),
    ...Object.values(xobjects),
    latin1("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
  ]);
};

const BILEVEL_ROW_BYTES = Math.ceil(SCAN.width / 8);

export const bilevelRows = Uint8Array.from(
  { length: BILEVEL_ROW_BYTES * SCAN.height },
  (_, index) =>
    Math.floor(index / BILEVEL_ROW_BYTES) < SCAN.height / 2 && (index % BILEVEL_ROW_BYTES) % 2 === 0
      ? 0x0f
      : 0xff,
);

const fullPage = (name: string) =>
  `q ${PAGE.width.toString()} 0 0 ${PAGE.height.toString()} 0 0 cm /${name} Do Q\n`;

const bilevelImage = () =>
  stream(
    `/Type /XObject /Subtype /Image /Width ${SCAN.width.toString()} /Height ${SCAN.height.toString()} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode`,
    deflateSync(bilevelRows),
  );

const hiddenText = "BT 3 Tr /F1 12 Tf 50 700 Td (Testo OCR nascosto) Tj ET\n";
const visibleText = "BT /F1 12 Tf 50 700 Td (Timbro visibile) Tj ET\n";

export const bilevelScanPdf = () => onePage(fullPage("Scan"), { Scan: bilevelImage() });

export const jpegScanPdf = scanJpeg.pipe(
  Effect.map((jpeg) =>
    onePage(fullPage("Scan"), {
      Scan: stream(
        "/Type /XObject /Subtype /Image /Width 420 /Height 594 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode",
        jpeg,
      ),
    }),
  ),
);

export const mrcScanPdf = () =>
  onePage(`${fullPage("Background")}0 0 0 rg\n${fullPage("Ink")}`, {
    Background: stream(
      `/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`,
      deflateSync(new Uint8Array(12).fill(0xfa)),
    ),
    Ink: stream(
      `/Type /XObject /Subtype /Image /Width ${SCAN.width.toString()} /Height ${SCAN.height.toString()} /ImageMask true /BitsPerComponent 1 /Filter /FlateDecode`,
      deflateSync(bilevelRows),
    ),
  });

export const ocrScanPdf = () => onePage(fullPage("Scan") + hiddenText, { Scan: bilevelImage() });

export const stampedScanPdf = () =>
  onePage(fullPage("Scan") + visibleText, { Scan: bilevelImage() });

export const formPlacedScanPdf = () =>
  onePage("/Placed Do\n", {
    Placed: stream(
      `/Type /XObject /Subtype /Form /BBox [0 0 1 1] /Matrix [${PAGE.width.toString()} 0 0 ${PAGE.height.toString()} 0 0] /Resources << /XObject << /Scan 6 0 R >> >>`,
      latin1("/Scan Do\n"),
    ),
    Scan: bilevelImage(),
  });

export const emptyPdf = () => onePage("", {});

export const cmykJpegScanPdf = readFixture("scan-cmyk.jpg").pipe(
  Effect.map((jpeg) =>
    onePage(fullPage("Scan"), {
      Scan: stream(
        "/Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceCMYK /BitsPerComponent 8 /Decode [1 0 1 0 1 0 1 0] /Filter /DCTDecode",
        jpeg,
      ),
    }),
  ),
);

export const COLOR_SCAN_PIXELS = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 255],
] as const;

export const colorScanPdf = () =>
  onePage(fullPage("Scan"), {
    Scan: stream(
      "/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode",
      deflateSync(Uint8Array.from(COLOR_SCAN_PIXELS.flat())),
    ),
  });

export const redPagePdf = () =>
  onePage(`1 0 0 rg 0 0 ${PAGE.width.toString()} ${PAGE.height.toString()} re f\n`, {});

export const SMILEY_TEXT = "\u{1F600}";

const type3Font = (toUnicode: string) =>
  latin1(
    `<< /Type /Font /Subtype /Type3 /FontBBox [0 0 500 700] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /g1 8 0 R >> /Encoding << /Type /Encoding /Differences [1 /g1] >> /FirstChar 1 /LastChar 1 /Widths [500] /Resources << >>${toUnicode} >>`,
  );

export const unmappedFontPdf = () =>
  assemble([
    ...pageTree(
      "/Font << /T3 5 0 R /E3 6 0 R /F1 7 0 R >>",
      "BT /E3 12 Tf 50 700 Td (\u0001) Tj ET BT /F1 12 Tf 100 700 Td (Firma SIGFIELD:cliente-0-1) Tj ET BT /T3 12 Tf 50 650 Td (\u0001\u0001\u0001) Tj ET",
    ),
    type3Font(""),
    type3Font(" /ToUnicode 9 0 R"),
    latin1("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    stream("", latin1("500 0 0 0 400 700 d1 0 0 400 700 re f")),
    stream(
      "",
      latin1(
        "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Smiley def 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <01> <D83DDE00> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end",
      ),
    ),
  ]);

export const SIGNATURE_TOKEN = { x: 72, y: 600 } as const;

export const textPdf = (pages: readonly (readonly string[])[]) =>
  fixture(async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    for (const lines of pages) {
      const page = document.addPage([PAGE.width, PAGE.height]);
      for (const [index, line] of lines.entries()) {
        page.drawText(line, { font, size: 11, x: SIGNATURE_TOKEN.x, y: 760 - index * 20 });
      }
      page.drawText("SIGFIELD:cliente-0-1", {
        font,
        size: 4,
        x: SIGNATURE_TOKEN.x,
        y: SIGNATURE_TOKEN.y,
      });
    }
    return await document.save();
  });

export const formPdf = fixture(async () => {
  const document = await PDFDocument.create();
  const page = document.addPage([PAGE.width, PAGE.height]);
  const form = document.getForm();
  const company = form.createTextField("ragioneSociale");
  company.addToPage(page, { height: 20, width: 240, x: 50, y: 700 });
  company.setText("Bianchi Software S.r.l.");
  form.createCheckBox("privacy").addToPage(page, { height: 12, width: 12, x: 50, y: 660 });
  const province = form.createDropdown("provincia");
  province.addToPage(page, { height: 20, width: 80, x: 50, y: 620 });
  province.addOptions(["MI", "RM", "TO"]);
  province.select("MI");
  const payment = form.createRadioGroup("pagamento");
  payment.addOptionToPage("bonifico", page, { height: 12, width: 12, x: 50, y: 580 });
  payment.addOptionToPage("contanti", page, { height: 12, width: 12, x: 80, y: 580 });
  return await document.save();
});

export const LONG_FORM_LAST_PAGE = 11;

export const longFormPdf = fixture(async () => {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const pages = Array.from({ length: LONG_FORM_LAST_PAGE + 1 }, (_, index) => {
    const page = document.addPage([PAGE.width, PAGE.height]);
    page.drawText(`Pagina numero ${index.toString()}`, { font, size: 11, x: 72, y: 760 });
    return page;
  });
  const company = document.getForm().createTextField("ragioneSociale");
  company.addToPage(pages[LONG_FORM_LAST_PAGE] ?? document.addPage(), {
    height: 20,
    width: 240,
    x: 50,
    y: 700,
  });
  company.setText("Bianchi Software S.r.l.");
  return await document.save();
});

export const loadWithPdfLib = (bytes: Uint8Array) =>
  fixture(async () => await PDFDocument.load(bytes));
