import { fileURLToPath } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { Address } from "./fixtures/xsd-codegen/defaults.gen.ts";
import { codec } from "../src/index.ts";
import * as Xsd from "../src/xsd.ts";

const DEFAULTS_XSD = fileURLToPath(new URL("fixtures/xsd-codegen/defaults.xsd", import.meta.url));

const address = (content: string) => `<Address><City>Roma</City>${content}</Address>`;

const addressCodec = Effect.fromResult(codec(Address));

layer(NodeServices.layer, { timeout: 60_000 })("elements with a default value", (it) => {
  it.effect.each([
    ["a required element with a value", "<Country>FR</Country>", { Country: "FR" }],
    ["a required empty element", "<Country/>", { Country: "IT" }],
    [
      "a required element with an empty start and end tag",
      "<Country></Country>",
      { Country: "IT" },
    ],
    ["an optional empty element", "<Country/><Currency/>", { Country: "IT", Currency: "EUR" }],
    [
      "an optional element with a value",
      "<Country/><Currency>USD</Currency>",
      { Country: "IT", Currency: "USD" },
    ],
    [
      "repeated elements, some of them empty",
      "<Country/><Label/><Label>office</Label>",
      { Country: "IT", Label: ["home", "office"] },
    ],
    [
      "an empty element of a type that accepts the empty string",
      "<Country/><Note/>",
      { Country: "IT", Note: "none" },
    ],
    [
      "an element with a value of a type that accepts the empty string",
      "<Country/><Note>call first</Note>",
      { Country: "IT", Note: "call first" },
    ],
  ] as const)("decode %s as libxml2 reads it", ([, content, expected]) =>
    Effect.gen(function* test() {
      const validator = yield* Xsd.make({ schema: { path: DEFAULTS_XSD } });
      const { decode } = yield* addressCodec;

      const xsd = yield* Effect.exit(validator.validate(address(content)));
      const decoded = yield* decode(address(content));

      expect(xsd).toStrictEqual(Exit.void);
      expect(decoded).toStrictEqual({ City: "Roma", ...expected });
    }),
  );

  it.effect.each([
    ["a required element that breaks the pattern", "<Country>fr</Country>"],
    ["a required element with only whitespace", "<Country> </Country>"],
    ["an optional element outside the enumeration", "<Country/><Currency>GBP</Currency>"],
  ] as const)("reject %s as libxml2 does", ([, content]) =>
    Effect.gen(function* test() {
      const validator = yield* Xsd.make({ schema: { path: DEFAULTS_XSD } });
      const { decode } = yield* addressCodec;

      const xsd = yield* Effect.exit(validator.validate(address(content)));
      const decoded = yield* Effect.exit(decode(address(content)));

      expect(Exit.isFailure(xsd)).toBe(true);
      expect(Exit.isFailure(decoded)).toBe(true);
    }),
  );

  it.effect("decode a missing required element to its default, which libxml2 rejects", () =>
    Effect.gen(function* test() {
      const validator = yield* Xsd.make({ schema: { path: DEFAULTS_XSD } });
      const { decode } = yield* addressCodec;

      const xsd = yield* Effect.exit(validator.validate(address("")));
      const decoded = yield* decode(address(""));

      expect(Exit.isFailure(xsd)).toBe(true);
      expect(decoded).toStrictEqual({ City: "Roma", Country: "IT" });
    }),
  );

  it.effect("leave a missing optional element out instead of giving it its default", () =>
    Effect.gen(function* test() {
      const { decode } = yield* addressCodec;

      const decoded = yield* decode(address("<Country>FR</Country>"));

      expect(decoded).toStrictEqual({ City: "Roma", Country: "FR" });
    }),
  );

  it.effect("encode the default of a decoded missing element into a document libxml2 accepts", () =>
    Effect.gen(function* test() {
      const validator = yield* Xsd.make({ schema: { path: DEFAULTS_XSD } });
      const { decode, encode } = yield* addressCodec;

      const xml = yield* encode(yield* decode(address("")));

      expect(xml).toBe(`<?xml version="1.0" encoding="UTF-8"?>${address("<Country>IT</Country>")}`);
      expect(yield* Effect.exit(validator.validate(xml))).toStrictEqual(Exit.void);
    }),
  );
});
