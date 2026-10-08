import { Data, Effect } from "effect";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { A4 } from "#effect-pdf/testing";

export class FixtureError extends Data.TaggedError("FixtureError")<{ readonly cause: unknown }> {
  readonly code = "FIXTURE";
}

export const fixture = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ catch: (cause) => new FixtureError({ cause }), try: run });

export const SIGNATURE_TOKEN = { x: 72, y: 600 } as const;

export const textPdf = (pages: readonly (readonly string[])[]) =>
  fixture(async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    for (const lines of pages) {
      const page = document.addPage([A4.width, A4.height]);
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
  const page = document.addPage([A4.width, A4.height]);
  const form = document.getForm();
  const company = form.createTextField("ragioneSociale");
  company.addToPage(page, { height: 20, width: 240, x: 50, y: 700 });
  company.setText("Azienda di Prova S.r.l.");
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
    const page = document.addPage([A4.width, A4.height]);
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
  company.setText("Azienda di Prova S.r.l.");
  return await document.save();
});

export const loadWithPdfLib = (bytes: Uint8Array) =>
  fixture(async () => await PDFDocument.load(bytes));
