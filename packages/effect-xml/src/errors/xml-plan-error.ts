import { Data } from "effect";

export class XmlPlanError extends Data.TaggedError("XmlPlanError")<{
  readonly message: string;
  readonly path: string;
}> {
  readonly code = "XML_PLAN";
}
