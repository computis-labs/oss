import { Schema } from "effect";

export class XmlPlanError extends Schema.TaggedError<
  XmlPlanError,
  { readonly brand: unique symbol }
>()("XmlPlanError", {
  message: Schema.String,
  path: Schema.String,
}) {
  readonly code = "XML_PLAN";
}
