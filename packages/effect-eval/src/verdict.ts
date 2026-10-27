import { Match, Option } from "effect";
import type { Agreement } from "./agreement.ts";
import { actualStates, expectedStates } from "./observation.ts";
import type { Observation } from "./observation.ts";
import { verdictClasses } from "./theme.ts";
import type { VerdictClass } from "./theme.ts";

export const verdicts = {
  errored: "errored",
  excluded: "excluded",
  gap: "gap",
  missed: "missed",
  partial: "partial",
  right: "right",
  unscored: "unscored",
  wrong: "wrong",
} as const;

export type Verdict = (typeof verdicts)[keyof typeof verdicts];

const ofAgreement: (agreement: Agreement) => Verdict = Match.type<Agreement>().pipe(
  Match.tagsExhaustive({
    Different: () => verdicts.wrong,
    Exact: () => verdicts.right,
    Partial: () => verdicts.partial,
  }),
);

export const of = (observation: Observation): Verdict => {
  if (Option.isSome(observation.excluded)) {
    return verdicts.excluded;
  }

  if (Option.isSome(observation.failure)) {
    return verdicts.errored;
  }

  if (observation.expected === expectedStates.unknown) {
    return verdicts.unscored;
  }

  if (observation.expected === expectedStates.absent) {
    return observation.actual === actualStates.absent ? verdicts.right : verdicts.wrong;
  }

  if (observation.actual === actualStates.absent) {
    return Option.isSome(observation.gap) ? verdicts.gap : verdicts.missed;
  }

  return Option.match(observation.agreement, { onNone: () => verdicts.wrong, onSome: ofAgreement });
};

export const classOf = (observation: Observation): Option.Option<VerdictClass> => {
  const verdict = of(observation);

  if (verdict === verdicts.gap) {
    return Option.some(verdictClasses.missed);
  }

  if (verdict === verdicts.unscored || verdict === verdicts.excluded) {
    return Option.none();
  }

  return Option.some(verdict);
};
