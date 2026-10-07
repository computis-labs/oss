# Contributing

Thanks for looking. This repository mirrors code that lives in Computis' private monorepo, so it works a little differently from most projects.

- **Issues** are welcome here: bugs, questions and ideas.
- **Pull requests** are welcome too, but they are not merged here. A maintainer brings the change into the monorepo, it ships with the next sync, and the pull request is closed with a link to the sync that carries it. The changelog entry credits you.
- Every sync overwrites `main`, so a commit pushed here directly would be lost.

Before you open a pull request, run:

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm oss:check
```

These packages are maintained on a best-effort basis, alongside the product they come from: there is no support SLA.
