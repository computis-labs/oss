# @computis/effect-github

## 0.1.1

### Patch Changes

- [`e3e2dd9`](https://github.com/computis-labs/oss/commit/e3e2dd96aeee6e6b7918cf3d4b53ff0b8af65a0c) Thanks [@zRelux](https://github.com/zRelux)! - Every action error now carries a fixed `code` field derived from its tag, for example `ACTION_INPUT` on `ActionInputError` and `ACTION_API` on `ActionApiError`.

## 0.1.0

### Minor Changes

- [`672601d`](https://github.com/computis-labs/oss/commit/672601d5a8c98c6efbae261cf1be77861198b3ac) Thanks [@Ceereals](https://github.com/Ceereals)! - First public release: write the logic of GitHub Actions with Effect 4. A port of `@effect-native/platform-github` with the runner, event context, Octokit client, job summary, schema-decoded inputs and `runMain`.
