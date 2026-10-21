import { Context, Effect, Match, MutableRef, Option } from "effect";
import type { EvalEvent, Scored } from "./events.ts";
import type { Observation } from "./observation.ts";
import type { Run } from "./run.ts";

export const REDACTED = "[redacted]";

export const UNLOGGED = "The run is sensitive, so its error is not logged.";

export const SensitiveExposure = Context.Reference<Option.Option<MutableRef.MutableRef<boolean>>>(
  "effect-eval/SensitiveExposure",
  { defaultValue: () => Option.none() },
);

export const exposing = (run: Run) =>
  run.sensitive
    ? SensitiveExposure.pipe(
        Effect.map(Option.map((exposed) => MutableRef.set(exposed, true))),
        Effect.asVoid,
      )
    : Effect.void;

export const RedactsSensitive = Context.Reference<boolean>("effect-eval/RedactsSensitive", {
  defaultValue: () => false,
});

export const redactObservation = (observation: Observation): Observation => ({
  ...observation,
  detail: { actual: REDACTED, expected: REDACTED },
  failure: observation.failure.pipe(Option.map(() => REDACTED)),
});

export const redactScored = (scored: Scored): Scored => ({
  ...scored,
  observation: redactObservation(scored.observation),
});

export const redactEvent = (event: EvalEvent): EvalEvent =>
  Match.valueTags(event, {
    CaseErrored: (errored): EvalEvent => ({
      ...errored,
      failure: REDACTED,
      judgements: [],
      observations: errored.observations.map(redactObservation),
    }),
    CaseFinished: (finished): EvalEvent => ({
      ...finished,
      judgements: [],
      observations: finished.observations.map(redactObservation),
      output: Option.none(),
      outputError: finished.outputError.pipe(Option.map(() => REDACTED)),
    }),
    CaseSkipped: (skipped): EvalEvent => skipped,
    CaseStarted: (started): EvalEvent => started,
    GateEvaluated: (gate): EvalEvent => ({
      ...gate,
      violations: gate.violations.map(redactScored),
    }),
    RunFinished: (finished): EvalEvent => finished,
    RunStarted: (started): EvalEvent => started,
    VariantFinished: (finished): EvalEvent => finished,
  });

export const redactRun = (run: Run): Run => ({
  ...run,
  gates: run.gates.map((gate) => ({ ...gate, violations: gate.violations.map(redactScored) })),
  outputs: run.outputs.map((output) => ({
    ...output,
    failure: output.failure.pipe(Option.map(() => REDACTED)),
    judgements: [],
    output: Option.none(),
    outputError: output.outputError.pipe(Option.map(() => REDACTED)),
  })),
  variants: run.variants.map((variant) => ({
    ...variant,
    observations: variant.observations.map(redactScored),
  })),
});
