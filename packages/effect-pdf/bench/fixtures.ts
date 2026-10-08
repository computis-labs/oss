import { deflateSync } from "node:zlib";
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";

const A4 = [595, 842] as const;
const SCAN_DPI = 200;
const LINES_PER_PAGE = 48;

export const invoicePdf = async (lineCount: number) => {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let first = 0; first < lineCount; first += LINES_PER_PAGE) {
    const page = document.addPage([...A4]);
    page.drawText("Fattura n. 2026/0042 — Azienda di Prova S.r.l. — P.IVA IT00000000000", {
      font,
      size: 11,
      x: 40,
      y: 800,
    });
    for (let line = first + 1; line <= Math.min(first + LINES_PER_PAGE, lineCount); line += 1) {
      page.drawText(
        `${line.toString().padStart(3, "0")}  Consulenza professionale periodo ${line.toString()} — revisione contabile   1   ${(line * 13.37).toFixed(2)} €   22%`,
        { font, size: 8, x: 40, y: 770 - (line - first) * 15 },
      );
    }
  }
  return await document.save();
};

export const bilevelScanPdf = async (pageCount: number) => {
  const width = Math.round((A4[0] / 72) * SCAN_DPI);
  const height = Math.round((A4[1] / 72) * SCAN_DPI);
  const rowBytes = Math.ceil(width / 8);
  const rows = Uint8Array.from({ length: rowBytes * height }, (_, index) =>
    Math.floor(index / rowBytes) % 40 < 14 && (index % rowBytes) % 9 < 6 ? 0x81 : 0xff,
  );
  const document = await PDFDocument.create();
  const image = document.context.register(
    document.context.stream(deflateSync(rows), {
      BitsPerComponent: 1,
      ColorSpace: "DeviceGray",
      Filter: "FlateDecode",
      Height: height,
      Subtype: "Image",
      Type: "XObject",
      Width: width,
    }),
  );
  for (let page = 0; page < pageCount; page += 1) {
    const added = document.addPage([...A4]);
    added.node.setXObject(PDFName.of("Scan"), image);
    added.node.set(
      PDFName.of("Contents"),
      document.context.register(
        document.context.stream(`q ${A4[0].toString()} 0 0 ${A4[1].toString()} 0 0 cm /Scan Do Q`),
      ),
    );
  }
  return await document.save();
};

export const jpegScanPdf = async (jpeg: Uint8Array) => {
  const document = await PDFDocument.create();
  const image = await document.embedJpg(jpeg);
  document.addPage([...A4]).drawImage(image, { height: A4[1], width: A4[0], x: 0, y: 0 });
  return await document.save();
};
