import { Duration, Effect, Exit, FileSystem, Predicate } from "effect";
import type { Scope } from "effect";
import { ParseOption, XmlDocument, XmlError, XmlLibError, XsdValidator } from "libxml2-wasm";
import { xmlRegisterFsInputProviders } from "libxml2-wasm/lib/nodejs.mjs";
import type { XsdIssue } from "./errors/xsd-validation-error.ts";
import { XsdValidationError } from "./errors/xsd-validation-error.ts";
import { XsdSchemaError } from "./errors/xsd-schema-error.ts";

export type XsdSchemaSource =
  | { readonly path: string }
  | { readonly contents: Uint8Array; readonly url: string };

export interface XsdValidatorOptions {
  readonly schema: XsdSchemaSource;
}

export interface XsdValidatorApi {
  readonly validate: (xml: string | Uint8Array) => Effect.Effect<void, XsdValidationError>;
}

const utf8 = new TextEncoder();

// oxlint-disable-next-line no-bitwise -- libxml2 parse options are bit flags
const PARSE_OPTION = ParseOption.XML_PARSE_NO_XXE | ParseOption.XML_PARSE_NONET;

const registerFsInputProviders = Effect.runSync(
  Effect.cachedWithTTL(Effect.sync(xmlRegisterFsInputProviders), (exit) =>
    Exit.isSuccess(exit) && exit.value ? Duration.infinity : Duration.zero,
  ),
);

const libxml2Issues = (cause: unknown) =>
  cause instanceof XmlLibError
    ? cause.details.map((detail): XsdIssue => ({
        column: detail.col,
        line: detail.line,
        message: detail.message.trimEnd(),
      }))
    : [];

const libxml2Message = (cause: unknown) =>
  cause instanceof XmlError ? cause.message.trimEnd() : "libxml2 failed without a diagnostic";

const validationError = (summary: string, cause: unknown, note = "") => {
  const issues = libxml2Issues(cause);
  return XsdValidationError.make({
    cause,
    issues,
    reason: issues.length === 0 ? `${summary}: ${libxml2Message(cause)}${note}` : summary,
  });
};

const toSchemaError = (cause: unknown) => {
  const issues = libxml2Issues(cause);
  return new XsdSchemaError({
    cause,
    message: `XSD schema could not be compiled: ${
      issues.length === 0
        ? libxml2Message(cause)
        : issues
            .map((issue) => `${String(issue.line)}:${String(issue.column)} ${issue.message}`)
            .join("; ")
    }`,
  });
};

const disposeDocument = (document: XmlDocument) =>
  Effect.sync(() => {
    document.dispose();
  });

export const make: (
  options: XsdValidatorOptions,
) => Effect.Effect<XsdValidatorApi, XsdSchemaError, Scope.Scope | FileSystem.FileSystem> =
  Effect.fn("Xsd.make")(function* makeXsdValidator({ schema }) {
    yield* registerFsInputProviders;
    const fs = yield* FileSystem.FileSystem;
    const source =
      "path" in schema
        ? {
            contents: yield* fs.readFile(schema.path).pipe(
              Effect.mapError(
                (cause) =>
                  new XsdSchemaError({
                    cause,
                    message: `XSD schema file could not be read: ${schema.path}`,
                  }),
              ),
            ),
            url: schema.path,
          }
        : schema;
    const schemaDocument = yield* Effect.acquireRelease(
      Effect.try({
        catch: toSchemaError,
        try: () =>
          XmlDocument.fromBuffer(source.contents, { option: PARSE_OPTION, url: source.url }),
      }),
      disposeDocument,
    );
    const validator = yield* Effect.acquireRelease(
      Effect.try({ catch: toSchemaError, try: () => XsdValidator.fromDoc(schemaDocument) }),
      (compiled) =>
        Effect.sync(() => {
          compiled.dispose();
        }),
    );
    const scope = yield* Effect.scope;

    return {
      validate: (xml) =>
        Effect.suspend(() =>
          Predicate.isTagged(scope.state, "Closed")
            ? Effect.die(new Error("Xsd validator used after the scope that built it was closed"))
            : Effect.acquireUseRelease(
                Effect.try({
                  catch: (cause) => validationError("XML document could not be parsed", cause),
                  try: () =>
                    XmlDocument.fromBuffer(xml instanceof Uint8Array ? xml : utf8.encode(xml), {
                      option: PARSE_OPTION,
                    }),
                }),
                (document) =>
                  Effect.try({
                    catch: (cause) => {
                      const { dtd } = document;
                      dtd?.dispose();
                      return validationError(
                        "XSD validation failed",
                        cause,
                        dtd === null
                          ? ""
                          : " (entity references declared in the DOCTYPE are not expanded)",
                      );
                    },
                    try: () => {
                      validator.validate(document);
                    },
                  }),
                disposeDocument,
              ),
        ),
    };
  });
