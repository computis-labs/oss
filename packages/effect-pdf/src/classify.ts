import * as Match from "effect/Match";
import * as Result from "effect/Result";
import { withPage } from "#effect-pdf/handle";
import type { PdfHandle } from "#effect-pdf/handle";
import { areaOf, overlapArea, pageBox, pageObjects, pageObjectTypes } from "#effect-pdf/objects";
import { pdfPageKinds } from "#effect-pdf/types";
import type { PdfClassification, PdfPageClassification, PdfPageKind } from "#effect-pdf/types";

const IMAGE_COVERAGE_THRESHOLD = 0.5;

export const classifyPage = (handle: PdfHandle, page: number) =>
  withPage(handle, page, (pagePointer) =>
    Result.map(pageObjects(handle.lib, pagePointer, page), (objects): PdfPageClassification => {
      const box = pageBox(handle.lib, pagePointer);
      const imageArea = objects
        .filter((object) => object.type === pageObjectTypes.image)
        .reduce((total, object) => total + overlapArea(object.bounds, box), 0);
      const pageArea = areaOf(box);
      const imageCoverage = pageArea > 0 ? Math.min(1, imageArea / pageArea) : 0;
      const text = objects.filter((object) => object.type === pageObjectTypes.text);
      const visibleText = text.some((object) => !object.invisibleText);
      const pictured = imageCoverage >= IMAGE_COVERAGE_THRESHOLD;
      const kind = Match.value({ pictured, visibleText }).pipe(
        Match.when({ pictured: true, visibleText: true }, (): PdfPageKind => pdfPageKinds.mixed),
        Match.when({ pictured: true }, () => pdfPageKinds.image),
        Match.when({ visibleText: true }, () => pdfPageKinds.text),
        Match.orElse(() => pdfPageKinds.empty),
      );
      return {
        hiddenText: text.some((object) => object.invisibleText),
        imageCoverage,
        kind,
        visibleText,
      };
    }),
  );

export const documentKind = (
  pages: readonly PdfPageClassification[],
): PdfClassification["kind"] => {
  const kinds = new Set(
    pages.map(({ kind }) => kind).filter((kind) => kind !== pdfPageKinds.empty),
  );
  const [only] = kinds;
  return kinds.size > 1 ? pdfPageKinds.mixed : (only ?? pdfPageKinds.empty);
};
