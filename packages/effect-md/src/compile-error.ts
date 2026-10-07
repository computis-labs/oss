import { whenDefined } from "./object.ts";
import { Schema } from "effect";
import { locate } from "./errors.ts";
import type { SourceFile } from "./errors.ts";

export const PromptCompileErrorReason = {
  ConstantCondition: "ConstantCondition",
  CyclicPartial: "CyclicPartial",
  DuplicatePromptName: "DuplicatePromptName",
  FileNotAllowed: "FileNotAllowed",
  InvalidHelperArgument: "InvalidHelperArgument",
  InvalidIterable: "InvalidIterable",
  InvalidOutput: "InvalidOutput",
  InvalidPartial: "InvalidPartial",
  InvalidPromptName: "InvalidPromptName",
  LiteralMismatch: "LiteralMismatch",
  MissingPartial: "MissingPartial",
  MissingPartialInput: "MissingPartialInput",
  MissingValue: "MissingValue",
  NotAStruct: "NotAStruct",
  UnknownField: "UnknownField",
  UnknownHelper: "UnknownHelper",
  UnknownVariable: "UnknownVariable",
} as const;

export class PromptCompileError extends Schema.TaggedError<PromptCompileError>()(
  "PromptCompileError",
  {
    column: Schema.Number,
    detail: Schema.String,
    line: Schema.Number,
    offset: Schema.Number,
    path: Schema.optionalKey(Schema.String),
    reason: Schema.Literals(Object.values(PromptCompileErrorReason)),
  },
) {
  override get message() {
    return `${this.path ?? "<prompt>"}:${this.line}:${this.column} ${this.detail}`;
  }
}

export const compileError = (
  file: SourceFile,
  offset: number,
  reason: (typeof PromptCompileErrorReason)[keyof typeof PromptCompileErrorReason],
  detail: string,
) =>
  PromptCompileError.make({
    ...locate(file.text, offset),
    detail,
    offset,
    reason,
    ...whenDefined(file.path, (path) => ({ path })),
  });
