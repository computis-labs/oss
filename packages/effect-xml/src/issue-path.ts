import { Array as Arr, Predicate, SchemaAST, SchemaIssue } from "effect";
import type { Schema } from "effect";
import { localName, positionAt } from "./characters.ts";
import type { XmlValue } from "./encoder.ts";
import type { XmlPosition } from "./errors/xml-position.ts";
import { tokenize } from "./tokenizer.ts";

interface Located {
  readonly keys: readonly PropertyKey[];
  readonly message: string;
}

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();
const formatIssue = SchemaIssue.makeFormatterDefault();

const formatted = (issue: SchemaIssue.Issue, keys: readonly PropertyKey[]): Located => {
  const [first] = formatIssues(issue).issues;
  return {
    keys: [
      ...keys,
      ...(first?.path ?? []).map((segment) =>
        Predicate.isObjectKeyword(segment) ? segment.key : segment,
      ),
    ],
    message: first?.message ?? formatIssue(issue),
  };
};

const locate = (
  issue: SchemaIssue.Issue,
  keys: readonly PropertyKey[],
  input: XmlValue,
): Located => {
  if (Predicate.isTagged(issue, "Pointer")) {
    return locate(issue.issue, [...keys, ...issue.path], input);
  }
  if (Predicate.isTagged(issue, "Composite")) {
    return locate(issue.issues[0], keys, input);
  }
  const members = Predicate.isTagged(issue, "AnyOf")
    ? issue.ast.types.filter(SchemaAST.isObjects)
    : [];
  if (!Predicate.isTagged(issue, "AnyOf") || members.length !== issue.ast.types.length) {
    return formatted(issue, keys);
  }
  const value = Arr.reduce<PropertyKey, unknown>(keys, input, (current, key) =>
    Predicate.hasProperty(current, key) ? current[key] : undefined,
  );
  const names = members.map(
    (member) => new Set(member.propertySignatures.map((property) => property.name)),
  );
  const distinctive = members.map((member) =>
    member.propertySignatures.filter((property) =>
      names.some((others) => !others.has(property.name)),
    ),
  );
  const labels = distinctive.map((properties) =>
    properties
      .filter((property) => !SchemaAST.isOptional(property.type))
      .map((property) => String(property.name))
      .join("+"),
  );
  if (members.length < 2 || labels.includes("")) {
    return formatted(issue, keys);
  }
  const present = members.filter((_, index) =>
    (distinctive[index] ?? []).some((property) => Predicate.hasProperty(value, property.name)),
  );
  const [member] = present;
  const chosen =
    present.length === 1
      ? issue.issues.find((candidate) => "ast" in candidate && candidate.ast === member)
      : undefined;
  return chosen === undefined
    ? { keys, message: `Expected one of ${labels.join(" | ")}.` }
    : locate(chosen, keys, input);
};

export const firstIssue = (rootName: string, error: Schema.SchemaError, input?: XmlValue) => {
  const { keys, message } = locate(error.issue, [], input);
  const path = Arr.reduce(keys, rootName, (prefix, key) =>
    Predicate.isNumber(key) ? `${prefix}[${String(key)}]` : `${prefix}.${String(key)}`,
  );
  return { keys, message, path };
};

export const issuePosition = (xml: string, keys: readonly PropertyKey[]): XmlPosition => {
  const targets: { readonly index: number; readonly name: string }[] = [];
  for (let position = 0; position < keys.length; position += 1) {
    const name = keys[position];
    if (!Predicate.isString(name)) {
      break;
    }
    const next = keys[position + 1];
    const index = Predicate.isNumber(next) ? next : 0;
    position += Predicate.isNumber(next) ? 1 : 0;
    targets.push({ index, name });
  }
  const elements: {
    readonly attributes: { readonly offset: number; readonly qname: string }[];
    readonly name: string;
    readonly offset: number;
    readonly parent: number | undefined;
  }[] = [];
  const open: number[] = [];
  tokenize(xml, {
    attribute: (qname, _value, offset) => {
      elements.at(-1)?.attributes.push({ offset, qname });
      return true;
    },
    close: () => {
      open.pop();
      return true;
    },
    openEnd: () => true,
    openStart: (qname, offset) => {
      elements.push({ attributes: [], name: localName(qname), offset, parent: open.at(-1) });
      open.push(elements.length - 1);
      return true;
    },
    text: () => true,
  });
  const chain = Arr.reduce(
    targets,
    elements.length === 0 ? [] : [0],
    (matched: readonly number[], target, position) => {
      const candidates =
        matched.length === position + 1
          ? elements.flatMap((element, index) =>
              element.parent === matched.at(-1) && element.name === target.name ? [index] : [],
            )
          : [];
      const found = candidates[target.index];
      return found === undefined ? matched : [...matched, found];
    },
  );
  const last = targets.at(-1);
  const owner = last === undefined ? undefined : elements[chain[targets.length - 1] ?? -1];
  const attribute = owner?.attributes.find(({ qname }) => qname === last?.name);
  return positionAt(xml, attribute?.offset ?? elements[chain.at(-1) ?? -1]?.offset ?? 0);
};
