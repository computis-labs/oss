import { Array as Arr, Effect, Predicate, Result, Schema } from "effect";
import { XmlEncodeError } from "./errors/xml-encode-error.ts";
import { firstIssue } from "./issue-path.ts";
import type { ElementPlan, RootPlan } from "./types.ts";

export type XmlValue = string | XmlObject | readonly XmlValue[] | undefined;

export interface XmlObject {
  readonly [key: string]: XmlValue;
}

export interface EncoderOptions {
  readonly declaration: boolean;
  readonly indent: number | string;
}

export type Encodable = Schema.Top & { readonly Encoded: XmlObject };

export type Encode<S extends Encodable> = (
  value: S["Type"],
) => Effect.Effect<string, XmlEncodeError, S["EncodingServices"]>;

interface ElementWriter {
  readonly attributes: readonly { readonly key: string; readonly prefix: string }[];
  readonly closeIndent: string;
  readonly steps: readonly Step[];
}

interface Step {
  readonly close: string;
  readonly element: ElementWriter | undefined;
  readonly key: string;
  readonly many: boolean;
  readonly open: string;
}

const SHORT_TEXT = 128;
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';
/* oxlint-disable no-control-regex -- control characters excluded from Char */
const ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/u;
const TEXT_SPECIAL = /[&<>\r\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/u;
const TEXT_SPECIAL_HEAD = /[&<>\u0000-\u0008\u000B-\u000E]/u;
// oxlint-disable-next-line require-unicode-regexp -- also finds surrogate halves
const CONTROL_TAIL_AND_SURROGATES = /[\u000F-\u001E\uD800-\uDFFF]/;
const ATTRIBUTE_SPECIAL =
  /[&<"\t\n\r\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/u;
/* oxlint-enable no-control-regex */
const TEXT_SPECIAL_ALL = /[&<>\r]/gu;
const TEXT_ENTITIES = new Map([
  ["\r", "&#13;"],
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
]);
const ATTRIBUTE_SPECIAL_ALL = /[&<"\t\n\r]/gu;
const ATTRIBUTE_ENTITIES = new Map([
  ["\t", "&#9;"],
  ["\n", "&#10;"],
  ["\r", "&#13;"],
  ['"', "&quot;"],
  ["&", "&amp;"],
  ["<", "&lt;"],
]);

export const escapeAttribute = (value: string) =>
  ATTRIBUTE_SPECIAL.test(value)
    ? value.replace(ATTRIBUTE_SPECIAL_ALL, (char) => ATTRIBUTE_ENTITIES.get(char) ?? char)
    : value;

const illegalAt = (value: string, path: string): XmlEncodeError | undefined => {
  const index = value.search(ILLEGAL);
  const code = (value.codePointAt(index) ?? 0).toString(16).toUpperCase().padStart(4, "0");
  return index === -1
    ? undefined
    : XmlEncodeError.make({ path, reason: `Character U+${code} is not allowed in XML 1.0.` });
};

const findIllegal = (step: Step, value: XmlValue, path: string): XmlEncodeError | undefined => {
  if (Predicate.isString(value)) {
    return illegalAt(value, path);
  }
  const writer = step.element;
  if (value === undefined || Arr.isArray<XmlValue>(value) || writer === undefined) {
    return undefined;
  }
  for (const { key } of writer.attributes) {
    const item = value[key];
    const found = Predicate.isString(item) ? illegalAt(item, `${path}.${key}`) : undefined;
    if (found !== undefined) {
      return found;
    }
  }
  for (const child of writer.steps) {
    const item = value[child.key];
    if (child.many && Arr.isArray<XmlValue>(item)) {
      for (const [index, entry] of item.entries()) {
        const found = findIllegal(child, entry, `${path}.${child.key}[${String(index)}]`);
        if (found !== undefined) {
          return found;
        }
      }
    } else {
      const found = findIllegal(child, item, `${path}.${child.key}`);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
};

export const makeWriter = (plan: RootPlan, options: Partial<EncoderOptions> = {}) => {
  const indent = Predicate.isNumber(options.indent)
    ? " ".repeat(options.indent)
    : (options.indent ?? "");
  const pretty = indent !== "";
  const newline = (depth: number) => (pretty ? `\n${indent.repeat(depth)}` : "");
  const writers = new Map<ElementPlan, Map<number, ElementWriter>>();

  const elementWriter = (element: ElementPlan, depth: number): ElementWriter => {
    const level = pretty ? depth : 0;
    const byDepth = writers.get(element) ?? new Map<number, ElementWriter>();
    writers.set(element, byDepth);
    const cached = byDepth.get(level);
    if (cached !== undefined) {
      return cached;
    }
    const writer: ElementWriter = {
      attributes: [...element.attributes.values()].map((attribute) => ({
        key: attribute.name,
        prefix: ` ${attribute.name}="`,
      })),
      closeIndent: newline(level),
      steps: element.sequence.map((child) => {
        const nested =
          child.node.kind === "element" ? elementWriter(child.node, level + 1) : undefined;
        const open =
          nested !== undefined && nested.attributes.length > 0 ? `<${child.name}` : child.openTag;
        return {
          close: child.closeTag,
          element: nested,
          key: child.name,
          many: child.arity === "many",
          open: `${newline(level + 1)}${open}`,
        };
      }),
    };
    byDepth.set(level, writer);
    return writer;
  };

  const rootWriter = elementWriter(plan.node, 0);
  const rootStep: Step = {
    close: plan.closeTag,
    element: rootWriter,
    key: plan.name,
    many: false,
    open: rootWriter.attributes.length > 0 ? plan.openTagStart : `${plan.openTagStart}>`,
  };
  const prolog = options.declaration === false ? "" : XML_DECLARATION;
  const header = prolog === "" || !pretty ? prolog : `${prolog}\n`;

  const writeValue = (parts: string[], step: Step, value: XmlValue): boolean => {
    if (Predicate.isString(value)) {
      const special =
        value.length <= SHORT_TEXT
          ? TEXT_SPECIAL.test(value)
          : TEXT_SPECIAL_HEAD.test(value) ||
            CONTROL_TAIL_AND_SURROGATES.test(value) ||
            value.includes("\u001F") ||
            value.includes("\uFFFE") ||
            value.includes("\uFFFF");
      if (special && ILLEGAL.test(value)) {
        return false;
      }
      parts.push(
        step.open,
        special
          ? value.replace(TEXT_SPECIAL_ALL, (char) => TEXT_ENTITIES.get(char) ?? char)
          : value,
        step.close,
      );
      return true;
    }
    const writer = step.element;
    if (value === undefined || Arr.isArray<XmlValue>(value) || writer === undefined) {
      return true;
    }
    parts.push(step.open);
    if (writer.attributes.length > 0) {
      for (const attribute of writer.attributes) {
        const item = value[attribute.key];
        if (Predicate.isString(item)) {
          if (ATTRIBUTE_SPECIAL.test(item) && ILLEGAL.test(item)) {
            return false;
          }
          parts.push(attribute.prefix, escapeAttribute(item), '"');
        }
      }
      parts.push(">");
    }
    const before = parts.length;
    const legal = writer.steps.every((child) => {
      const item = value[child.key];
      return child.many && Arr.isArray<XmlValue>(item)
        ? item.every((entry) => writeValue(parts, child, entry))
        : writeValue(parts, child, item);
    });
    parts.push(parts.length === before ? step.close : writer.closeIndent + step.close);
    return legal;
  };

  return (encoded: XmlObject): Result.Result<string, XmlEncodeError> => {
    const parts = [header];
    return writeValue(parts, rootStep, encoded)
      ? Result.succeed(parts.join(""))
      : Result.fail(
          findIllegal(rootStep, encoded, plan.name) ??
            XmlEncodeError.make({ path: plan.name, reason: "Character not allowed in XML 1.0." }),
        );
  };
};

export const makePlanEncoder = <S extends Encodable>(
  schema: S,
  plan: RootPlan,
  options?: Partial<EncoderOptions>,
): Encode<S> => {
  const write = makeWriter(plan, options);
  const encode = Schema.encodeEffect(schema);
  return (value) =>
    encode(value).pipe(
      Effect.matchEffect({
        onFailure: (error) => {
          const { message, path } = firstIssue(plan.name, error);
          return Effect.fail(XmlEncodeError.make({ cause: error, path, reason: message }));
        },
        onSuccess: (encoded) => Effect.fromResult(write(encoded)),
      }),
    );
};
