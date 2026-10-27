import { Effect, Schema } from "effect";

export const isText = Schema.is(Schema.String);
export const isList = Schema.is(Schema.Array(Schema.Json));
export const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Json));

export const canonical = (value: Schema.Json): string => {
  if (isList(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }

  if (isRecord(value)) {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key] ?? null)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
};

export const sha256 = (text: string) =>
  Effect.promise(
    async () => await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  ).pipe(
    Effect.map((buffer) =>
      Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );
