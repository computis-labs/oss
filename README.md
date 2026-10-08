# Computis open source packages

Effect libraries that [Computis](https://computis.it) builds and uses in production.

| Package                                       | What it does                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [`@computis/effect-xml`](packages/effect-xml) | XML decoding and encoding with Effect Schema, XSD validation, and an XSD to Effect Schema generator |
| [`@computis/effect-md`](packages/effect-md)   | LLM prompts written as Markdown files and compiled to typed Effect AI prompts                       |
| [`@computis/effect-pdf`](packages/effect-pdf) | Read, render and fill PDFs with Effect, on PDFium compiled to WebAssembly and a pool of workers     |

Every package needs Effect 4 and ships as ESM only. effect-xml and effect-md run on Node 22 or later, effect-pdf on Node 24.15 or later.

## How this repository works

The packages are developed in Computis' private monorepo, next to the product that uses them. This repository is a read-only mirror of them: each sync from the monorepo is one commit, and the packages are published to npm from here. See [CONTRIBUTING.md](CONTRIBUTING.md) for how issues and pull requests reach the monorepo.

## Develop

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm oss:check
```

`pnpm oss:check` packs every package, lints the tarballs with publint and attw, installs them in an empty project and loads every entry point.

## License

MIT, except for the third-party test fixtures listed in each package's `tests/fixtures/NOTICE`.
