import { Match, Schema } from "effect";

export const AgreementSchema = Schema.Union([
  Schema.TaggedStruct("Exact", {}),
  Schema.TaggedStruct("Partial", {
    score: Schema.Finite.check(Schema.isBetween({ maximum: 1, minimum: 0 })),
  }),
  Schema.TaggedStruct("Different", {}),
]);
export type Agreement = typeof AgreementSchema.Type;

export const exact: Agreement = { _tag: "Exact" };

export const different: Agreement = { _tag: "Different" };

export const partial = (score: number): Agreement => {
  if (score >= 1) {
    return exact;
  }
  if (score <= 0) {
    return different;
  }
  return { _tag: "Partial", score };
};

export const credit: (agreement: Agreement) => number = Match.type<Agreement>().pipe(
  Match.tagsExhaustive({
    Different: () => 0,
    Exact: () => 1,
    Partial: ({ score }) => score,
  }),
);
