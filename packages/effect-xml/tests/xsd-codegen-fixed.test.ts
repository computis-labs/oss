import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "@effect/vitest";
import { Effect, Exit } from "effect";

import { codec } from "../src/index.ts";
import * as Xsd from "../src/xsd.ts";
import { Report } from "./fixtures/xsd-codegen/fixed.gen.ts";

const FIXED_XSD = fileURLToPath(
  new URL("fixtures/xsd-codegen/fixed.xsd", import.meta.url)
);

const report = (attributes: string) =>
  `<Report ${attributes}><Total>12.20</Total></Report>`;

const reportCodec = Effect.fromResult(codec(Report));

layer(NodeServices.layer, { timeout: 60_000 })(
  "attributes with a fixed value",
  (it) => {
    it.effect.each([
      ["the required attribute alone", 'format="R10"', { format: "R10" }],
      [
        "both attributes with their fixed values",
        'format="R10" simulated="true"',
        { format: "R10", simulated: "true" },
      ],
    ] as const)("decode %s as libxml2 accepts it", ([, attributes, expected]) =>
      Effect.gen(function* test() {
        const validator = yield* Xsd.make({ schema: { path: FIXED_XSD } });
        const { decode, encode } = yield* reportCodec;

        const xsd = yield* Effect.exit(validator.validate(report(attributes)));
        const decoded = yield* decode(report(attributes));

        const encoded = yield* Effect.exit(
          validator.validate(yield* encode(decoded))
        );

        expect([xsd, encoded]).toStrictEqual([Exit.void, Exit.void]);
        expect(decoded).toStrictEqual({ Total: "12.20", ...expected });
      })
    );

    it.effect.each([
      ["a required attribute with another value", 'format="R11"'],
      [
        "an optional attribute with another value",
        'format="R10" simulated="false"',
      ],
      ["a missing required attribute", 'simulated="true"'],
    ] as const)("reject %s as libxml2 does", ([, attributes]) =>
      Effect.gen(function* test() {
        const validator = yield* Xsd.make({ schema: { path: FIXED_XSD } });
        const { decode } = yield* reportCodec;

        const xsd = yield* Effect.exit(validator.validate(report(attributes)));
        const decoded = yield* Effect.exit(decode(report(attributes)));

        expect(Exit.isFailure(xsd)).toBe(true);
        expect(Exit.isFailure(decoded)).toBe(true);
      })
    );
  }
);
