import { describe, expect, it } from "@effect/vitest";
import { XmlDecodeError } from "../src/errors/xml-decode-error.ts";
import { XmlEncodeError } from "../src/errors/xml-encode-error.ts";
import { XmlParseError } from "../src/errors/xml-parse-error.ts";
import { XsdValidationError } from "../src/errors/xsd-validation-error.ts";

describe("error messages", () => {
  it("describes a decode failure with its path and position", () => {
    const error = XmlDecodeError.make({
      path: "FatturaElettronica.FatturaElettronicaHeader.CedentePrestatore.Sede.Provincia",
      position: { column: 12, line: 2, offset: 40 },
      reason: "Expected a string of at most 2 characters",
    });

    expect(error.message).toBe(
      "Expected a string of at most 2 characters at FatturaElettronica.FatturaElettronicaHeader.CedentePrestatore.Sede.Provincia (line 2, column 12)",
    );
  });

  it("describes a decode failure without a position with its path only", () => {
    const error = XmlDecodeError.make({ path: "Documento.Titolo", reason: "Missing key" });

    expect(error.message).toBe("Missing key at Documento.Titolo");
  });

  it("keeps the structured fields of a decode failure", () => {
    const cause = new Error("schema");

    const error = XmlDecodeError.make({
      cause,
      path: "Documento.Titolo",
      position: { column: 3, line: 1, offset: 2 },
      reason: "Missing key",
    });

    expect(error).toMatchObject({
      cause,
      path: "Documento.Titolo",
      position: { column: 3, line: 1, offset: 2 },
    });
  });

  it("describes a parse failure with its position", () => {
    const error = XmlParseError.make({
      position: { column: 14, line: 1, offset: 13 },
      reason: "Unexpected closing tag </B>",
    });

    expect(error.message).toBe("Unexpected closing tag </B> (line 1, column 14)");
  });

  it("describes an encode failure with its path", () => {
    const error = XmlEncodeError.make({
      path: "Documento.Nota[1].Testo",
      reason: "Character U+0001 is not allowed in XML 1.0.",
    });

    expect(error.message).toBe(
      "Character U+0001 is not allowed in XML 1.0. at Documento.Nota[1].Testo",
    );
  });

  it("describes every XSD issue with its line and column", () => {
    const error = XsdValidationError.make({
      issues: [
        { column: 1, line: 1, message: "Element 'Numero': missing." },
        { column: 7, line: 4, message: "Element 'Data': invalid." },
      ],
      reason: "XSD validation failed",
    });

    expect(error.message).toBe(
      "XSD validation failed: Element 'Numero': missing. (line 1, column 1); Element 'Data': invalid. (line 4, column 7)",
    );
  });

  it("describes an XSD failure without issues with its reason only", () => {
    const error = XsdValidationError.make({
      issues: [],
      reason: "XSD validation failed: libxml2 failed without a diagnostic",
    });

    expect(error.message).toBe("XSD validation failed: libxml2 failed without a diagnostic");
  });
});
