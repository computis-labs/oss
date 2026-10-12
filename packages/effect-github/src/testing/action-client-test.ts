import { Redacted } from "effect";
import type { Layer } from "effect";
import { ActionClient } from "../action-client.ts";

export const make = (options: { readonly fetch?: typeof globalThis.fetch } = {}) =>
  ActionClient.layer(Redacted.make("test-token"), {
    request: {
      fetch:
        options.fetch ??
        (async () =>
          await Promise.resolve(Response.json({ message: "Not Found" }, { status: 404 }))),
    },
  });

export const layer: Layer.Layer<ActionClient> = make();
