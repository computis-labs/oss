import { fileURLToPath } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "@effect/vitest";
import { Array as Arr, Effect, Exit, Schema } from "effect";
import * as Facets from "./fixtures/xsd-codegen/facets.gen.ts";
import * as Xsd from "../src/xsd.ts";

const FACETS_XSD = fileURLToPath(new URL("fixtures/xsd-codegen/facets.xsd", import.meta.url));

const SAMPLES = [
  "AB12CD",
  "hello",
  "a@b.c",
  "-12.34",
  "ABCDEF2AXYZ",
  "x",
  "  x",
  " x y",
  "abab",
  "ĀŽ",
  "é",
  "^-[]",
  "$^}",
  "a b",
  "Ͱ",
  "a  b",
  "\u{1F600}\u{1F600}",
  "\ta\n",
  " Dott. ",
  "1",
  "+1",
  "-1.",
  ".5",
  "1.2.3",
  " 1 ",
  "1e3",
  "+.5",
  "100.00",
  "100.01",
  "0001",
  "1970-01-01",
  "1969-12-31",
  "2024-02-29",
  "2023-02-29",
  "2024-01-01+14:00",
  " 2024-01-01 ",
  "0000-01-01",
  "2024-01-01T23:59:60",
  "2024-01-01T12:00:00.5Z",
  "12",
  "1+2",
  "-1.00",
  "99.50",
  "99.51",
  "..",
  "+12",
  "1.5",
  "12345678901.00",
  "2024-02-30T00:00:00",
  "QUI=",
  "QR==",
  "Q Q = =",
  "QUJD\nREVG",
  "SI",
  "ABC",
  " SI ",
  "SI\n",
  "S I",
  "NO",
  " a\tb ",
  "a\tb",
  "x y",
  " x  y ",
  "+1.0",
  "01.00",
  "1.00",
  "2.50",
  "-12.34",
  "-012.3400",
  "0",
  "-0",
  "+0.0",
  "0.5",
  ".50",
  "-1",
  "-0001",
  "9999",
  "+09999",
  "2024-02-29Z",
  "2024-01-01Z",
  "2024-01-01+00:00",
  "2024-01-01-00:00",
  "2024-01-01+01:00",
  "1970-01-01+14:00",
  "1969-12-31-10:00",
  " 2024-02-29\n",
  "2024-01-01T12:00:00Z",
  "2024-01-01T13:00:00+01:00",
  "2024-01-01T12:00:00.000+00:00",
  "2024-01-01T12:00:00",
  "2024-01-01T12:00:00.5",
  "2024-01-01T12:00:00.500",
  "2024-01-01T12:00:00.5Z",
  ...[
    0x7f, 0x80, 0xff, 0x1_00, 0x1_7f, 0x1_80, 0x2_4f, 0x2_50, 0x2_af, 0x2_b0, 0x2_ff, 0x3_00,
    0x3_6f, 0x3_70, 0x3_ff, 0x4_00, 0x4_ff, 0x5_00, 0x1d_ff, 0x1e_00, 0x1e_ff, 0x1f_00, 0x20_00,
    0x20_6f, 0x20_70, 0x20_a0, 0x20_cf, 0x20_d0,
  ].map((codePoint) => String.fromCodePoint(codePoint)),
];

const MUTATIONS = [
  "a",
  "Z",
  "0",
  "9",
  " ",
  "\t",
  "\n",
  "\r",
  "-",
  ".",
  "@",
  '"',
  "[",
  "]",
  "\\",
  "!",
  "#",
  "~",
  "^",
  "_",
  "/",
  "+",
  ":",
  "T",
  "=",
  "\u007F",
  "\u0080",
  "\u00FF",
  "\u0100",
  "\uD7FF",
  "\uE000",
  "\uFFFD",
  "\u{1F600}",
  "\u{10000}",
];

layer(NodeServices.layer, { timeout: 120_000 })("facets generated from an XSD", (it) => {
  it.effect(
    "accept the values libxml2 accepts, except malformed base64 that libxml2 lets through",
    () =>
      Effect.gen(function* test() {
        const validator = yield* Xsd.make({ schema: { path: FACETS_XSD } });
        const states = Arr.scan(
          Arr.makeBy(SAMPLES.length * 12 * 4, () => 0),
          1,
          (state) => (state * 1_103_515_245 + 12_345) % 2_147_483_648,
        );
        const random = (draw: number, bound: number) =>
          Math.floor(((states[draw + 1] ?? 0) / 2_147_483_648) * bound);
        const values = new Set(SAMPLES);
        for (const [sampleIndex, sample] of SAMPLES.entries()) {
          const chars = Array.from(sample.matchAll(/[\s\S]/gu), ([char]) => char);
          for (let step = 0; step < 12; step += 1) {
            const draw = (sampleIndex * 12 + step) * 4;
            const position = random(draw, chars.length + 1);
            const char = MUTATIONS[random(draw + 1, MUTATIONS.length)] ?? "";
            chars.splice(
              position,
              random(draw + 2, 3) === 0 ? 0 : 1,
              ...(random(draw + 3, 4) === 0 ? [] : [char]),
            );
            values.add(chars.join(""));
          }
        }
        const unsound: string[] = [];
        const incomplete: string[] = [];
        for (const [name, schema] of Object.entries(Facets)) {
          const accepts = Schema.is(schema);
          for (const value of name === "Facets" ? [] : values) {
            const text = value
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;")
              .replaceAll("\r", "&#13;");
            const exit = yield* Effect.exit(
              validator.validate(`<Facets><${name}>${text}</${name}></Facets>`),
            );
            if (accepts(value) && Exit.isFailure(exit)) {
              unsound.push(`${name} ${JSON.stringify(value)}`);
            }
            if (!accepts(value) && Exit.isSuccess(exit) && name !== "Base64") {
              incomplete.push(`${name} ${JSON.stringify(value)}`);
            }
          }
        }

        expect(values.size).toBeGreaterThan(500);
        expect(unsound).toStrictEqual([]);
        expect(incomplete).toStrictEqual([]);
      }),
  );
});
