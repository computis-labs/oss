import type { Schema as S } from "effect";
import type { XsdDomain } from "../../../src/xsd-codegen/runtime.ts";

const identity = (self: S.String) => self;

export const Schema = { CodeType: identity } satisfies XsdDomain;

export const root = { CodeType: identity } satisfies XsdDomain;

export const xsdPattern = { CodeType: identity } satisfies XsdDomain;
