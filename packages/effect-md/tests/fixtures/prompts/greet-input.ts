import { Schema } from "effect";

export const GreetInput = Schema.Struct({
  count: Schema.Number,
  name: Schema.String,
  nickname: Schema.optionalKey(Schema.String),
});
