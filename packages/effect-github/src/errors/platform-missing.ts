import { Schema } from "effect";

export class PlatformMissing extends Schema.TaggedError<PlatformMissing>()("PlatformMissing", {
  platform: Schema.String,
}) {
  override get message() {
    return `runMain runs on an Effect platform package: install ${this.platform} next to @computis/effect-github.`;
  }
}
