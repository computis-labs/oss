# Contributing

Thanks for looking. This repository mirrors code that lives in Computis' private monorepo, so pull requests take one extra step, but they are welcome.

## Issues

Bugs, questions and ideas are welcome as issues.

## Pull requests

1. Open the pull request here, against `main`, and sign off every commit (see below).
2. A maintainer reviews it here. When it is ready, they add the `import` label.
3. A bot copies it into the monorepo, keeping you as the author, and comments here. The full test suite runs there. If you push again, the bot brings the new commits over within half an hour.
4. When it lands in the monorepo, the next sync brings it back here: your commits join the history of `main`, this pull request shows as merged, and the bot comments with the commit that carries it.
5. The next release lists the change in the package's `CHANGELOG.md`, with a link to your pull request and a thank-you.

Every sync overwrites `main`, so commits pushed here directly would be lost: everything goes through a pull request.

### Sign-off

By signing off a commit you certify the [Developer Certificate of Origin](https://developercertificate.org/): you wrote the change, or you have the right to submit it under the repository's MIT license. Add the line with `git commit --signoff` (or `-s`). It reads:

```
Signed-off-by: Your Name <you@example.com>
```

and the email must match the commit author. The `Sign-off` check fails until every commit of the pull request carries it. To fix older commits, run `git rebase --signoff main` and push again.

## Before you open a pull request

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm oss:check
```

These packages are maintained on a best-effort basis, alongside the product they come from: there is no support SLA.
