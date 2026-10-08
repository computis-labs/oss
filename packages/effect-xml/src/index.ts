import { Effect, Result, SchemaAST } from "effect";
import type { FileSystem, Path, Scope } from "effect";
import { SchemaJITCompiler } from "effect/schema";
import { makeDecoder } from "./decoder.ts";
import type { Decode, DecoderOptions } from "./decoder.ts";
import { makePlanEncoder } from "./encoder.ts";
import type { Encodable, Encode, EncoderOptions } from "./encoder.ts";
import type { XmlPlanError } from "./errors/xml-plan-error.ts";
import type { XsdSchemaError } from "./errors/xsd-schema-error.ts";
import { compile } from "./plan.ts";
import * as Xsd from "./xsd.ts";
import type { XsdSchemaSource, XsdValidatorApi } from "./xsd.ts";

export { element, root } from "./annotations.ts";

export interface CodecOptions {
  readonly decoder?: Partial<DecoderOptions>;
  readonly encoder?: Partial<EncoderOptions>;
  /**
   * Compiles this codec's Schema with the Effect Schema JIT (default `true`). The JIT registry is
   * process-wide: `false` only skips enabling it here, sub-schemas compiled elsewhere stay compiled.
   */
  readonly jit?: boolean;
}

export interface ValidatingCodecOptions extends CodecOptions {
  /** The XSD compiled once, in the caller's scope, for `validate`. */
  readonly xsd: XsdSchemaSource;
}

export interface ValidatingCodec<S extends Encodable> {
  readonly decode: Decode<S>;
  readonly encode: Encode<S>;
  readonly validate: XsdValidatorApi["validate"];
}

export const codec = <S extends Encodable>(schema: S, options: CodecOptions = {}) =>
  Result.map(compile(schema), (plan) => {
    if (options.jit !== false) {
      SchemaJITCompiler.enable(schema.ast);
      SchemaJITCompiler.enable(SchemaAST.flip(schema.ast));
    }
    return {
      decode: makeDecoder(schema, plan, options.decoder),
      encode: makePlanEncoder(schema, plan, options.encoder),
      plan,
    };
  });

export const make: <S extends Encodable>(
  schema: S,
  options: ValidatingCodecOptions,
) => Effect.Effect<
  ValidatingCodec<S>,
  XmlPlanError | XsdSchemaError,
  Scope.Scope | FileSystem.FileSystem | Path.Path
> = Effect.fn("EffectXml.make")(function* makeValidatingCodec<S extends Encodable>(
  schema: S,
  options: ValidatingCodecOptions,
) {
  const { decode, encode } = yield* Effect.fromResult(codec(schema, options));
  const { validate } = yield* Xsd.make({ schema: options.xsd });
  return { decode, encode, validate };
});
