import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Result from "effect/Result";
import { constUndefined } from "effect/Function";
import { PdfFormError } from "./errors/pdf-form-error.ts";
import type { PdfPageError } from "./errors/pdf-page-error.ts";
import { withAnnotation, withFormEnvironment, withFormPage } from "./handle.ts";
import type { PdfHandle } from "./handle.ts";
import { readFloats, readUtf16 } from "./memory.ts";
import type { Pdfium } from "./pdfium.ts";
import { rectBetween } from "./objects.ts";
import { pdfFieldTypes } from "./types.ts";
import type { PdfField, PdfFieldType, PdfFieldValue, PdfRect } from "./types.ts";

const WIDGET_SUBTYPE = 20;
const fieldTypeCodes: readonly PdfFieldType[] = [
  pdfFieldTypes.unknown,
  pdfFieldTypes.button,
  pdfFieldTypes.checkbox,
  pdfFieldTypes.radio,
  pdfFieldTypes.combobox,
  pdfFieldTypes.listbox,
  pdfFieldTypes.text,
  pdfFieldTypes.signature,
];

export const textualTypes: ReadonlySet<PdfFieldType> = new Set([
  pdfFieldTypes.combobox,
  pdfFieldTypes.listbox,
  pdfFieldTypes.text,
]);
export const choiceTypes: ReadonlySet<PdfFieldType> = new Set([
  pdfFieldTypes.combobox,
  pdfFieldTypes.listbox,
]);
const toggleTypes: ReadonlySet<PdfFieldType> = new Set([
  pdfFieldTypes.checkbox,
  pdfFieldTypes.radio,
]);

export interface Widget {
  readonly annotationIndex: number;
  readonly exportValue: string;
  readonly name: string;
  readonly options: readonly string[];
  readonly page: number;
  readonly rect: PdfRect;
  readonly type: PdfFieldType;
  readonly value: PdfFieldValue | undefined;
}

export const readFieldValue = (lib: Pdfium, form: number, annotation: number) =>
  readUtf16(lib, (buffer, size) => lib.FPDFAnnot_GetFormFieldValue(form, annotation, buffer, size));

const unreadable = (field: string, what: string) =>
  Result.fail(
    new PdfFormError({ field, message: `PDFium could not read the ${what} of field "${field}".` }),
  );

export const readWidgets = (
  handle: PdfHandle,
  signatureFields: ReadonlySet<number>,
  form: number,
): Result.Result<readonly Widget[], PdfFormError | PdfPageError> => {
  const { lib } = handle;
  const pages = Arr.makeBy(handle.pageCount, (page) =>
    withFormPage(handle, form, page, (pagePointer) =>
      Result.succeed(
        Arr.makeBy(lib.FPDFPage_GetAnnotCount(pagePointer), (annotationIndex) =>
          withAnnotation(
            handle,
            pagePointer,
            annotationIndex,
            (annotation): Result.Result<Widget, PdfFormError> | undefined => {
              if (lib.FPDFAnnot_GetSubtype(annotation) !== WIDGET_SUBTYPE) {
                return undefined;
              }
              const name = readUtf16(lib, (buffer, size) =>
                lib.FPDFAnnot_GetFormFieldName(form, annotation, buffer, size),
              );
              if (name === null) {
                return Result.fail(
                  new PdfFormError({ message: "PDFium could not read the name of a field." }),
                );
              }
              const corners = readFloats(lib, 4, (rect) => lib.FPDFAnnot_GetRect(annotation, rect));
              if (corners === null) {
                return unreadable(name, "position");
              }
              const type = signatureFields.has(
                lib.EPDFAnnot_GetFormFieldObjectNumber(form, annotation),
              )
                ? pdfFieldTypes.signature
                : (fieldTypeCodes[lib.FPDFAnnot_GetFormFieldType(form, annotation)] ??
                  pdfFieldTypes.unknown);
              const exportValue = toggleTypes.has(type)
                ? readUtf16(lib, (buffer, size) =>
                    lib.FPDFAnnot_GetFormFieldExportValue(form, annotation, buffer, size),
                  )
                : "";
              if (exportValue === null) {
                return unreadable(name, "export value");
              }
              const options = choiceTypes.has(type)
                ? Arr.makeBy(lib.FPDFAnnot_GetOptionCount(form, annotation), (option) =>
                    readUtf16(lib, (buffer, size) =>
                      lib.FPDFAnnot_GetOptionLabel(form, annotation, option, buffer, size),
                    ),
                  )
                : [];
              const labels = options.flatMap((label) => (label === null ? [] : [label]));
              if (labels.length !== options.length) {
                return unreadable(name, "options");
              }
              const text = textualTypes.has(type) ? readFieldValue(lib, form, annotation) : "";
              if (text === null) {
                return unreadable(name, "value");
              }
              const checked = lib.FPDFAnnot_IsChecked(form, annotation);
              return Result.succeed({
                annotationIndex,
                exportValue,
                name,
                options: labels,
                page,
                rect: rectBetween(
                  corners[0] ?? 0,
                  corners[1] ?? 0,
                  corners[2] ?? 0,
                  corners[3] ?? 0,
                ),
                type,
                value: Match.value({ checked, type }).pipe(
                  Match.when(
                    ({ type: candidate }) => textualTypes.has(candidate),
                    (): PdfFieldValue | undefined => text,
                  ),
                  Match.when({ type: pdfFieldTypes.checkbox }, () => checked),
                  Match.when({ checked: true, type: pdfFieldTypes.radio }, () => exportValue),
                  Match.orElse(constUndefined),
                ),
              });
            },
          ),
        ).flatMap((widget) => (widget === undefined ? [] : [widget])),
      ),
    ),
  );
  return Result.all(pages).pipe(Result.flatMap((onPages) => Result.all(onPages.flat())));
};

export const readFields = (handle: PdfHandle, signatureFields: ReadonlySet<number>) =>
  withFormEnvironment(handle, (form) => readWidgets(handle, signatureFields, form)).pipe(
    Result.map((widgets) =>
      Arr.dedupe(widgets.map(({ name }) => name)).flatMap((name): PdfField[] => {
        const group = widgets.filter((widget) => widget.name === name);
        const [first] = group;
        return first === undefined
          ? []
          : [
              {
                name,
                type: first.type,
                value: group.find((widget) => widget.value !== undefined)?.value,
                widgets: group.map(({ page, rect }) => ({ page, rect })),
              },
            ];
      }),
    ),
  );
