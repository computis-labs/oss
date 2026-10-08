import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Result from "effect/Result";
import { constUndefined } from "effect/Function";
import { PdfFormError } from "#effect-pdf/errors/pdf-form-error";
import { choiceTypes, readFieldValue, readWidgets, textualTypes } from "#effect-pdf/form";
import type { Widget } from "#effect-pdf/form";
import { withAnnotation, withFormEnvironment, withFormPage } from "#effect-pdf/handle";
import type { PdfHandle } from "#effect-pdf/handle";
import { withAllocation, withUtf16 } from "#effect-pdf/memory";
import { pdfFieldTypes } from "#effect-pdf/types";
import type { PdfFieldValue, PdfSignatureField } from "#effect-pdf/types";

const TEXT_FIELD_CODE = 6;
const PRINT_FLAG = 4;
const UNCHECKED = "Off";
const NOT_AN_OPTION = -1;

const valueToStore = (widget: Widget, value: PdfFieldValue) =>
  Match.value(value).pipe(
    Match.when(Match.boolean, (checked) =>
      widget.type === pdfFieldTypes.checkbox
        ? Result.succeed<string | undefined>(checked ? widget.exportValue : UNCHECKED)
        : Result.fail(widget.type),
    ),
    Match.when(Match.string, (text) =>
      Match.value(widget.type).pipe(
        Match.when(pdfFieldTypes.radio, () =>
          Result.succeed(widget.exportValue === text ? text : undefined),
        ),
        Match.when(pdfFieldTypes.listbox, () =>
          Result.succeed(widget.options.includes(text) ? text : undefined),
        ),
        Match.when(
          (type) => textualTypes.has(type),
          () => Result.succeed<string | undefined>(text),
        ),
        Match.orElse(() => Result.fail(widget.type)),
      ),
    ),
    Match.exhaustive,
  );

export const setFieldValues = (
  handle: PdfHandle,
  signatureFields: ReadonlySet<number>,
  values: Readonly<Record<string, PdfFieldValue>>,
) =>
  withFormEnvironment(handle, (form) =>
    readWidgets(handle, signatureFields, form).pipe(
      Result.flatMap((widgets) => {
        const byName = Arr.groupBy(widgets, (widget) => widget.name);
        const unknown = Object.keys(values).filter((name) => !Object.hasOwn(byName, name));
        const [firstUnknown] = unknown;
        if (firstUnknown !== undefined) {
          return Result.fail(
            new PdfFormError({
              field: firstUnknown,
              message: `The document has no field named ${unknown.map((name) => `"${name}"`).join(", ")}.`,
            }),
          );
        }
        const [problem] = Object.entries(values).flatMap(([name, value]) => {
          const stored = (byName[name] ?? []).map((widget) => valueToStore(widget, value));
          const refused = stored.find(Result.isFailure);
          if (refused !== undefined) {
            return [
              new PdfFormError({
                field: name,
                message: `Field "${name}" is a ${refused.failure} field and cannot take ${JSON.stringify(value)}.`,
              }),
            ];
          }
          return stored.some((result) => Result.isSuccess(result) && result.success !== undefined)
            ? []
            : [
                new PdfFormError({
                  field: name,
                  message: `Field "${name}" has no option ${JSON.stringify(value)}.`,
                }),
              ];
        });
        return problem === undefined ? Result.succeed(widgets) : Result.fail(problem);
      }),
      Result.flatMap((widgets) => {
        const { lib } = handle;
        const writes = widgets.flatMap((widget) => {
          const value = values[widget.name];
          const stored =
            value === undefined ? undefined : Result.getOrUndefined(valueToStore(widget, value));
          return stored === undefined ? [] : [{ stored, widget }];
        });
        return Result.all(
          Object.values(Arr.groupBy(writes, ({ widget }) => widget.page.toString())).map((onPage) =>
            withFormPage(handle, form, onPage[0].widget.page, (pagePointer) =>
              Result.all(
                onPage.map(({ stored, widget }) =>
                  withAnnotation(handle, pagePointer, widget.annotationIndex, (annotation) => {
                    const option = choiceTypes.has(widget.type)
                      ? widget.options.indexOf(stored)
                      : NOT_AN_OPTION;
                    const typed = textualTypes.has(widget.type) && option === NOT_AN_OPTION;
                    const accepted =
                      textualTypes.has(widget.type) || option !== NOT_AN_OPTION
                        ? lib.FORM_SetFocusedAnnot(form, annotation) &&
                          (typed
                            ? lib.FORM_SelectAllText(form, pagePointer) &&
                              withUtf16(lib, stored, (text) => {
                                lib.FORM_ReplaceSelection(form, pagePointer, text);
                                return true;
                              })
                            : lib.FORM_SetIndexSelected(form, pagePointer, option, true))
                        : withUtf16(lib, stored, (text) =>
                            lib.EPDFAnnot_SetFormFieldValue(form, annotation, text),
                          );
                    lib.FORM_ForceToKillFocus(form);
                    const kept =
                      !textualTypes.has(widget.type) ||
                      readFieldValue(lib, form, annotation) === stored;
                    return accepted && kept
                      ? Result.void
                      : Result.fail(
                          new PdfFormError({
                            field: widget.name,
                            message: `PDFium did not store ${JSON.stringify(stored)} in field "${widget.name}".`,
                          }),
                        );
                  }),
                ),
              ),
            ),
          ),
        );
      }),
      Result.map(constUndefined),
    ),
  );

export const createSignatureField = (handle: PdfHandle, { name, page, rect }: PdfSignatureField) =>
  withFormEnvironment(handle, (form) =>
    withFormPage(handle, form, page, (pagePointer) => {
      const { lib } = handle;
      const annotation = withUtf16(lib, name, (pointer) =>
        lib.EPDFPage_CreateFormField(pagePointer, form, TEXT_FIELD_CODE, pointer),
      );
      if (annotation === 0) {
        return Result.fail(
          new PdfFormError({ field: name, message: `PDFium could not add the field "${name}".` }),
        );
      }
      try {
        const placed = withAllocation(lib, 16, (pointer) => {
          lib.pdfium.HEAPF32.set([rect.left, rect.top, rect.right, rect.bottom], pointer / 4);
          return lib.FPDFAnnot_SetRect(annotation, pointer);
        });
        lib.FPDFAnnot_SetFlags(annotation, PRINT_FLAG);
        return placed
          ? Result.succeed(lib.EPDFAnnot_GetFormFieldObjectNumber(form, annotation))
          : Result.fail(
              new PdfFormError({
                field: name,
                message: `PDFium could not place the field "${name}" on page ${page.toString()}.`,
              }),
            );
      } finally {
        lib.FPDFPage_CloseAnnot(annotation);
      }
    }),
  );
