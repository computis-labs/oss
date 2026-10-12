import { Option, Schema } from "effect";

const decodeThrown = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }));

export const thrownMessage = (cause: unknown, fallback: string) =>
  Option.match(decodeThrown(cause), {
    onNone: () => fallback,
    onSome: (thrown) => thrown.message,
  });
