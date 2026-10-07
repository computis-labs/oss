import { Schema, SchemaTransformation } from "effect";
import type { XsdDomain } from "../../../src/xsd-codegen/runtime.ts";

const Upper = (self: Schema.String) =>
  self.check(Schema.isPattern(/^[A-Z]*$/u)).pipe(Schema.brand("Upper"));

export const domain = {
  "OrderType.Country": Upper,
  QuantityType: (self: Schema.String) =>
    self.pipe(Schema.decodeTo(Schema.Finite, SchemaTransformation.numberFromString)),
  "xs:token": Upper,
} satisfies XsdDomain;

export const OrderType = {
  CodeType: (self: Schema.String) => self,
  CountryType: Upper,
} satisfies XsdDomain;

export const unusedType = { MissingType: Upper } satisfies XsdDomain;

export const otherElement = { "LineType.Country": Upper } satisfies XsdDomain;

export const withString = { CodeType: "Upper" };

export const notADomain = Upper;
