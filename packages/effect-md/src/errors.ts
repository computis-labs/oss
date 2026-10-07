import { whenDefined } from "./object.ts";
import { Schema } from "effect";

export const PromptSyntaxErrorReason = {
  ConflictingInput: "ConflictingInput",
  DuplicateElse: "DuplicateElse",
  DuplicateField: "DuplicateField",
  InvalidBlockParams: "InvalidBlockParams",
  InvalidCondition: "InvalidCondition",
  InvalidExpression: "InvalidExpression",
  InvalidFrontmatter: "InvalidFrontmatter",
  InvalidIdentifier: "InvalidIdentifier",
  InvalidRoleTag: "InvalidRoleTag",
  InvalidSchemaReference: "InvalidSchemaReference",
  InvalidType: "InvalidType",
  InvalidYaml: "InvalidYaml",
  MismatchedClose: "MismatchedClose",
  RoleInsideBlock: "RoleInsideBlock",
  TextOutsideRole: "TextOutsideRole",
  UnclosedBlock: "UnclosedBlock",
  UnclosedRole: "UnclosedRole",
  UnexpectedClose: "UnexpectedClose",
  UnexpectedElse: "UnexpectedElse",
  UnexpectedToken: "UnexpectedToken",
  UnknownBlock: "UnknownBlock",
  UnknownDataVariable: "UnknownDataVariable",
  UnknownFrontmatterKey: "UnknownFrontmatterKey",
  UnterminatedComment: "UnterminatedComment",
  UnterminatedFrontmatter: "UnterminatedFrontmatter",
  UnterminatedString: "UnterminatedString",
  UnterminatedTag: "UnterminatedTag",
} as const;
export type SyntaxErrorReason =
  (typeof PromptSyntaxErrorReason)[keyof typeof PromptSyntaxErrorReason];

export class PromptSyntaxError extends Schema.TaggedError<PromptSyntaxError>()(
  "PromptSyntaxError",
  {
    column: Schema.Number,
    detail: Schema.String,
    line: Schema.Number,
    offset: Schema.Number,
    path: Schema.optionalKey(Schema.String),
    reason: Schema.Literals(Object.values(PromptSyntaxErrorReason)),
  },
) {
  override get message() {
    return `${this.path ?? "<prompt>"}:${this.line}:${this.column} ${this.detail}`;
  }
}

export interface SourceFile {
  readonly text: string;
  readonly path?: string;
}

export const locate = (text: string, offset: number) => {
  const before = text.slice(0, Math.max(offset, 0));
  const lineStart = before.lastIndexOf("\n") + 1;
  return { column: offset - lineStart + 1, line: before.split("\n").length };
};

export const syntaxError = (
  file: SourceFile,
  offset: number,
  reason: SyntaxErrorReason,
  detail: string,
) =>
  PromptSyntaxError.make({
    ...locate(file.text, offset),
    detail,
    offset,
    reason,
    ...whenDefined(file.path, (path) => ({ path })),
  });

export const didYouMean = (value: string, candidates: Iterable<string>) => {
  const needle = value.toLowerCase();
  const distanceTo = (candidate: string) => {
    const rows = [Array.from({ length: candidate.length + 1 }, (_, index) => index)];
    for (let row = 1; row <= needle.length; row += 1) {
      const previous = rows[row - 1] ?? [];
      const current = [row];
      for (let column = 1; column <= candidate.length; column += 1) {
        const cost = needle[row - 1] === candidate[column - 1] ? 0 : 1;
        current.push(
          Math.min(
            (previous[column] ?? 0) + 1,
            (current[column - 1] ?? 0) + 1,
            (previous[column - 1] ?? 0) + cost,
          ),
        );
      }
      rows.push(current);
    }
    return rows[needle.length]?.[candidate.length] ?? 0;
  };
  const maxDistance = Math.max(2, Math.floor(value.length / 3)) + 1;
  const [closest] = Array.from(candidates, (candidate) => ({
    candidate,
    score: distanceTo(candidate.toLowerCase()),
  }))
    .filter(({ score }) => score < maxDistance)
    .toSorted((left, right) => left.score - right.score);
  return closest !== undefined && closest.candidate.length > 0
    ? ` Did you mean '${closest.candidate}'?`
    : "";
};
