# @computis/effect-xml

Decode and encode XML with Effect Schema, validate it against an XSD, and generate the Schema from the XSD.

- One Schema describes the XML: struct fields are elements in order, and the fields you list as attributes are attributes.
- `codec(schema)` compiles the Schema once and returns `decode` (XML string to value) and `encode` (value to XML string). Both return an `Effect`.
- `make(schema, { xsd })` adds `validate`, which checks a document against the XSD with libxml2 compiled to WebAssembly. It reads no network resource and expands no external entity.
- The `effect-xml generate` CLI turns an XSD into a TypeScript module of Effect Schemas, with the XSD facets (patterns, lengths, ranges, enumerations) as Schema checks.

## Install

```sh
npm install @computis/effect-xml effect @effect/platform-node
```

It needs Effect 4 and Node 22 or later. The package is ESM only.

## Decode and encode

```ts
import { Effect, Schema } from "effect";
import { codec, root } from "@computis/effect-xml";

const Note = Schema.Struct({
  lang: Schema.optionalKey(Schema.String),
  to: Schema.String,
  body: Schema.String,
}).pipe(root("note", { attributes: ["lang"] }));

const program = Effect.gen(function* () {
  const { decode, encode } = yield* Effect.fromResult(codec(Note));
  const note = yield* decode(`<note lang="en"><to>Ada</to><body>Hello</body></note>`);
  // { lang: "en", to: "Ada", body: "Hello" }
  return yield* encode({ ...note, body: "Hello again" });
});
```

`codec` returns a `Result`: it fails with `XmlPlanError` when the Schema has no XML representation, for example an `optional` field, which can hold `undefined`. Use `optionalKey` instead.

| Annotation                                         | Meaning                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| `root(name, { attributes?, namespace?, prefix? })` | The root element: its name, the fields that are attributes, and its namespace. |
| `element({ attributes })`                          | A nested struct whose listed fields are attributes.                            |

| Option                    | Meaning                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `decoder.maxDepth`        | The deepest element nesting the decoder accepts. The default is 256.                   |
| `decoder.trimText`        | Removes the whitespace around the text of every leaf. The default keeps it as written. |
| `decoder.unknownElements` | `"error"` (the default) or `"skip"` for elements the Schema does not declare.          |
| `encoder.declaration`     | Writes the `<?xml …?>` declaration.                                                    |
| `encoder.indent`          | Indents the output with a number of spaces or a string.                                |
| `jit`                     | Compiles the Schema with the Effect Schema JIT. The default is `true`.                 |

## Validate against an XSD

```ts
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import * as EffectXml from "@computis/effect-xml";

const program = Effect.gen(function* () {
  const notes = yield* EffectXml.make(Note, { xsd: { path: "note.xsd" } });
  yield* notes.validate(`<note><to>Ada</to><body>Hello</body></note>`);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
```

`make` compiles the XSD once and frees it when its scope closes. `validate` fails with `XsdValidationError`, whose message lists each issue with its line and column. The XSD can also come from memory: `{ contents: Uint8Array, url }`, where `url` resolves the schemas it imports.

## Generate the Schema from an XSD

```sh
effect-xml generate --xsd schema/order.xsd --root Order --out src/order.gen.ts
```

| Flag           | Meaning                                                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--xsd`        | The XSD file.                                                                                                                                                           |
| `--root`       | The global element that becomes the root of the Schema.                                                                                                                 |
| `--out`        | The generated TypeScript file.                                                                                                                                          |
| `--prefix`     | The prefix of the root element. It is required when the local elements of the XSD are unqualified.                                                                      |
| `--runtime`    | The import specifier of the runtime helpers. The default is `@computis/effect-xml/xsd-codegen/runtime`.                                                                 |
| `--domain`     | `<module>#<export>`: an object of functions keyed by XSD type name. Each receives the generated Schema and returns the Schema to use. `<module>` resolves from `--out`. |
| `--format`     | A command that reads the code on stdin and writes the formatted code on stdout.                                                                                         |
| `--format-arg` | An argument of the `--format` command. Repeat it for each argument. `{file}` is replaced with the output path.                                                          |

The generated module exports one Schema per XSD type, and the root Schema is ready for `codec` and `make`. The same generator is available as a function from `@computis/effect-xml/xsd-codegen`.

## License

MIT
