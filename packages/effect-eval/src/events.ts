import { Schema } from "effect";
import { SummarySchema } from "./metric.ts";
import { ObservationSchema } from "./observation.ts";
import { UsageSchema } from "./usage.ts";

export const EVENTS_VERSION = 1;

const envelope = {
  at: Schema.DateTimeUtcFromString,
  runId: Schema.String,
  sequence: Schema.Finite,
  version: Schema.Literal(EVENTS_VERSION),
};

export const ScoredSchema = Schema.Struct({
  case: Schema.String,
  observation: ObservationSchema,
  trial: Schema.Finite,
  variant: Schema.String,
});

export type Scored = typeof ScoredSchema.Type;

export const GitInfoSchema = Schema.Struct({
  branch: Schema.OptionFromNullOr(Schema.String),
  dirty: Schema.Boolean,
  sha: Schema.OptionFromNullOr(Schema.String),
});

export type GitInfo = typeof GitInfoSchema.Type;

const gateFields = {
  actual: Schema.String,
  gate: Schema.String,
  passed: Schema.Boolean,
  scope: Schema.OptionFromNullOr(Schema.String),
  threshold: Schema.String,
  variant: Schema.String,
  violations: Schema.Array(ScoredSchema),
};

export const GateResultSchema = Schema.Struct(gateFields);

export type GateResult = typeof GateResultSchema.Type;

export const TrialStatsSchema = Schema.Struct({
  flaky: Schema.Array(
    Schema.Struct({
      case: Schema.String,
      key: Schema.String,
      verdicts: Schema.Array(Schema.String),
    }),
  ),
  k: Schema.Finite,
  metrics: Schema.Record(
    Schema.String,
    Schema.Struct({
      mean: Schema.OptionFromNullOr(Schema.Finite),
      standardDeviation: Schema.OptionFromNullOr(Schema.Finite),
    }),
  ),
  passAtK: Schema.OptionFromNullOr(Schema.Finite),
  passHatK: Schema.OptionFromNullOr(Schema.Finite),
  shortOfK: Schema.Finite,
});

export type TrialStats = typeof TrialStatsSchema.Type;

export const PlanSchema = Schema.Struct({
  cases: Schema.Finite,
  invocations: Schema.Finite,
  skipped: Schema.Finite,
});

export type Plan = typeof PlanSchema.Type;

export const RunStarted = Schema.TaggedStruct("RunStarted", {
  ...envelope,
  datasetHash: Schema.String,
  eval: Schema.String,
  git: GitInfoSchema,
  plan: PlanSchema,
  rescoreOf: Schema.OptionFromNullOr(Schema.String),
  sensitive: Schema.Boolean,
  trials: Schema.Finite,
  variants: Schema.Array(Schema.String),
});

export const CaseSkipped = Schema.TaggedStruct("CaseSkipped", {
  ...envelope,
  id: Schema.String,
  reason: Schema.String,
});

export const CaseStarted = Schema.TaggedStruct("CaseStarted", {
  ...envelope,
  case: Schema.String,
  tags: Schema.Array(Schema.String),
  trial: Schema.Finite,
  variant: Schema.String,
});

export const JudgementSchema = Schema.Struct({
  hash: Schema.String,
  key: Schema.String,
  result: Schema.Json,
});

export type Judgement = typeof JudgementSchema.Type;

const finishedFields = {
  ...envelope,
  case: Schema.String,
  durationMs: Schema.Finite,
  inputHash: Schema.String,
  judgements: Schema.Array(JudgementSchema),
  observations: Schema.Array(ObservationSchema),
  trial: Schema.Finite,
  usage: UsageSchema,
  variant: Schema.String,
};

export const CaseFinished = Schema.TaggedStruct("CaseFinished", {
  ...finishedFields,
  output: Schema.OptionFromOptionalKey(Schema.Json),
  outputError: Schema.OptionFromOptionalKey(Schema.String),
});

export const CaseErrored = Schema.TaggedStruct("CaseErrored", {
  ...finishedFields,
  failure: Schema.String,
});

export const VariantFinished = Schema.TaggedStruct("VariantFinished", {
  ...envelope,
  durationMs: Schema.Finite,
  groups: Schema.Record(Schema.String, SummarySchema),
  summary: SummarySchema,
  trials: Schema.OptionFromNullOr(TrialStatsSchema),
  usage: UsageSchema,
  variant: Schema.String,
});

export const GateEvaluated = Schema.TaggedStruct("GateEvaluated", {
  ...envelope,
  ...gateFields,
});

export const RunFinished = Schema.TaggedStruct("RunFinished", {
  ...envelope,
  durationMs: Schema.Finite,
  failedReporters: Schema.Array(Schema.String),
  interrupted: Schema.Boolean,
  passed: Schema.Boolean,
  unreportedUsage: Schema.optionalKey(
    Schema.Array(Schema.Struct({ usage: UsageSchema, variant: Schema.String })),
  ),
});

export const EvalEventSchema = Schema.Union([
  RunStarted,
  CaseSkipped,
  CaseStarted,
  CaseFinished,
  CaseErrored,
  VariantFinished,
  GateEvaluated,
  RunFinished,
]);

export type EvalEvent = typeof EvalEventSchema.Type;

export const isRunStarted = Schema.is(RunStarted);
export const isCaseSkipped = Schema.is(CaseSkipped);
export const isCaseStarted = Schema.is(CaseStarted);
export const isCaseFinished = Schema.is(CaseFinished);
export const isCaseErrored = Schema.is(CaseErrored);
export const isVariantFinished = Schema.is(VariantFinished);
export const isGateEvaluated = Schema.is(GateEvaluated);
export const isRunFinished = Schema.is(RunFinished);

type Envelope = keyof typeof envelope;

export type EventBody = EvalEvent extends infer Event
  ? Event extends EvalEvent
    ? Omit<Event, Envelope>
    : never
  : never;

const EventLine = Schema.fromJsonString(EvalEventSchema);

export const encodeLine = Schema.encodeEffect(EventLine);

export const decodeLine = Schema.decodeUnknownEffect(EventLine);
