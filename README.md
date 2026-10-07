# Computis open source packages

Effect libraries that [Computis](https://computis.it) builds and uses in production.

| Package                                       | What it does                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [`@computis/effect-xml`](packages/effect-xml) | XML decoding and encoding with Effect Schema, XSD validation, and an XSD to Effect Schema generator |
| [`@computis/effect-md`](packages/effect-md)   | LLM prompts written as Markdown files and compiled to typed Effect AI prompts                       |

Every package needs Effect 4 and Node 22 or later, and ships as ESM only.

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
