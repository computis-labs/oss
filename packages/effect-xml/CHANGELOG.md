# @computis/effect-xml

## 0.4.0

### Minor Changes

- [`f30df51`](https://github.com/computis-labs/oss/commit/f30df512c07b3afd61ab7c0de234d185a40ab571) Thanks [@zRelux](https://github.com/zRelux)! - Add the `decoder.blankLeaves` option. With `"drop"`, a leaf whose text is only whitespace decodes as if the element were absent, so an `xs:normalizedString` made only of line breaks, which the XSD accepts, no longer fails a pattern that asks for at least one character. The default `"keep"` decodes the text as before.

## 0.3.0

### Minor Changes

- [`e3e2dd9`](https://github.com/computis-labs/oss/commit/e3e2dd96aeee6e6b7918cf3d4b53ff0b8af65a0c) Thanks [@zRelux](https://github.com/zRelux)! - The errors are now `Schema.TaggedError` classes, so they carry a schema and can be encoded and decoded. Breaking: the `make({ reason, ... })` factory of `XmlParseError`, `XmlDecodeError`, `XmlEncodeError` and `XsdValidationError` is now `fromReason({ reason, ... })`, because `make` is the schema constructor.

## 0.2.0

### Minor Changes

- [#2](https://github.com/computis-labs/oss/pull/2) [`b808333`](https://github.com/computis-labs/oss/commit/b8083338749a35bde1965cf9b05eec87cb3ed0dd) Thanks [@riccardomenegazzo](https://github.com/riccardomenegazzo)! - Decoding a union now rejects an element whose children or attributes come from two different members, the way an XSD validator rejects both branches of an `xs:choice`. Before, the first member that matched kept its own fields and silently dropped the others. Now a member matches only when it declares every child and attribute the element holds. Values that a transformation produces, such as the object `Schema.fromJsonString` parses, keep the default handling of extra keys.

  Generated schemas now give an empty alternative a zero-property check, so a generated optional sequence rejects a document that fills it only in part. Run `effect-xml generate` again on your existing generated modules to get this check.

## 0.1.0

### Minor Changes

- First public release.
