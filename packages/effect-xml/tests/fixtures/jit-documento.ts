/* oxlint-disable sort-keys -- XML is sequence-typed: the Struct field order is the element order under test, so sorting the keys changes the documents. */
import { Effect, Schema } from "effect";
import { codec, root } from "../../src/index.ts";

const Documento = Schema.Struct({
  Titolo: Schema.String.pipe(Schema.check(Schema.isMaxLength(20))),
  Righe: Schema.Array(Schema.Struct({ Codice: Schema.String, Quantita: Schema.NumberFromString })),
}).pipe(root("Documento"));

const xml =
  "<Documento><Titolo>Offerta</Titolo><Righe><Codice>A1</Codice><Quantita>2</Quantita></Righe></Documento>";

export const runDocumento = (jit: boolean) =>
  Effect.gen(function* decodeAndEncodeDocumento() {
    const { decode, encode } = yield* Effect.fromResult(codec(Documento, { jit }));
    const documento = yield* decode(xml);
    return { documento, written: yield* encode(documento) };
  });
