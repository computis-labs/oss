import * as Result from "effect/Result";
import type { Pdfium } from "#effect-pdf/pdfium";
import { PdfPageError } from "#effect-pdf/errors/pdf-page-error";

export interface PdfHandle {
  readonly document: number;
  readonly lib: Pdfium;
  readonly pageCount: number;
}

export const withPage = <A, E>(
  { document, lib }: PdfHandle,
  page: number,
  action: (pagePointer: number) => Result.Result<A, E>,
): Result.Result<A, E | PdfPageError> => {
  const pagePointer = lib.FPDF_LoadPage(document, page);
  if (pagePointer === 0) {
    return Result.fail(PdfPageError.unreadable(page));
  }
  try {
    return action(pagePointer);
  } finally {
    lib.FPDF_ClosePage(pagePointer);
  }
};

export const withFormEnvironment = <A>(
  { document, lib }: PdfHandle,
  action: (form: number) => A,
): A => {
  const info = lib.PDFiumExt_OpenFormFillInfo();
  const form = lib.PDFiumExt_InitFormFillEnvironment(document, info);
  try {
    return action(form);
  } finally {
    lib.PDFiumExt_ExitFormFillEnvironment(form);
    lib.PDFiumExt_CloseFormFillInfo(info);
  }
};

export const withFormPage = <A, E>(
  handle: PdfHandle,
  form: number,
  page: number,
  action: (pagePointer: number) => Result.Result<A, E>,
): Result.Result<A, E | PdfPageError> =>
  withPage(handle, page, (pagePointer) => {
    handle.lib.FORM_OnAfterLoadPage(pagePointer, form);
    try {
      return action(pagePointer);
    } finally {
      handle.lib.FORM_OnBeforeClosePage(pagePointer, form);
    }
  });

export const selectedPages = (
  { pageCount }: Pick<PdfHandle, "pageCount">,
  pages: readonly number[] | undefined,
): Result.Result<readonly number[], PdfPageError> => {
  const selection = pages ?? Array.from({ length: pageCount }, (_, index) => index);
  const outside = selection.find(
    (page) => !Number.isInteger(page) || page < 0 || page >= pageCount,
  );
  return outside === undefined
    ? Result.succeed(selection)
    : Result.fail(PdfPageError.outOfRange(outside, pageCount));
};

export const withAnnotation = <A>(
  { lib }: PdfHandle,
  pagePointer: number,
  index: number,
  action: (annotation: number) => A,
): A => {
  const annotation = lib.FPDFPage_GetAnnot(pagePointer, index);
  try {
    return action(annotation);
  } finally {
    lib.FPDFPage_CloseAnnot(annotation);
  }
};
