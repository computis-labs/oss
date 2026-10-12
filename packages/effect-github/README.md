# @computis/effect-github

Write the logic of a GitHub Actions step with Effect: read inputs, write outputs and the job summary, read the event, call the GitHub API through Octokit, and fail the step with a readable message.

It is a port to Effect 4 of [`@effect-native/platform-github`](https://github.com/effect-native/effect-native/tree/tom/platform-github/packages-native/platform-github), which targets Effect 3. The API follows it; [Differences from upstream](#differences-from-upstream) lists where it departs.

## Install

```sh
npm install @computis/effect-github effect @effect/platform-node
```

It needs Effect 4 and Node 22 or later, and ships as ESM only. It runs on Node only: `@actions/core` and `@actions/github` underneath are Node libraries. `runMain` loads `@effect/platform-node` when it starts and fails the step with a message naming it when it is not installed; the other modules do not need it.

## Use

| Module           | Holds                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `action`         | `runMain`, `layer`, `layerConfig`, `makeRuntime`                                                                         |
| `action-runner`  | `ActionRunner`: inputs, outputs, annotations, groups, state, secrets, OIDC (`@actions/core`)                             |
| `action-context` | `ActionContext`: event, repository, run; `decodePayload` decodes the event with a schema                                 |
| `action-client`  | `ActionClient`: `octokit`, `request`, `graphql`, `paginate`, and `*Decoded` variants that decode with a schema           |
| `action-summary` | `ActionSummary`: the job summary builder                                                                                 |
| `input`          | `Input`: action inputs decoded by a schema (`integer`, `boolean`, `json`, `secret`, …)                                   |
| `errors/*`       | One tagged error per module, `ActionFailed` to fail the step, `action-failure` for `isActionError` and `isActionFailure` |
| `testing/*`      | `ActionRunnerTest`, `ActionContextTest`, `ActionClientTest`, `ActionSummaryTest`: `make` and a default `layer` each      |

```ts
import { runMain } from "@computis/effect-github/action";
import { ActionRunner } from "@computis/effect-github/action-runner";
import { ActionFailed } from "@computis/effect-github/errors/action-failed";
import { Config, Effect } from "effect";

runMain(
  Effect.gen(function* publishVerdict() {
    const runner = yield* ActionRunner;
    const result = yield* Config.String("RESULT");
    yield* runner.setOutput("verdict", result);
    if (result === "block") {
      return yield* new ActionFailed({ message: "The review found blocking issues." });
    }
  }),
);
```

`runMain` provides every service, reports the failure with `core.setFailed` and exits with 1.
The client reads its token from `INPUT_GITHUB_TOKEN`, then `GITHUB_TOKEN`; without one, it sends
anonymous requests, and GitHub answers 401 or 404 for what needs a token. `paginate` stops at
100 pages unless `maxPages` says otherwise, and fails when the collection is longer.

Every service method also has a module-level accessor, as in upstream: `getInput`, `setOutput`,
`group`, `eventName`, `repo`, `request`, `write` and the rest.

A step started with `run: node script.ts` has no action inputs: GitHub sets `INPUT_*` only for a
`uses:` action. Read what the step passes through `env:` with `Config`.

## Differences from upstream

The API follows upstream. These parts differ on purpose:

| Upstream                                                        | Here                                                                                                                                                          |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request<T>`, `graphql<T>`, `paginate<T>` cast to `T`           | They return JSON values; `requestDecoded`, `graphqlDecoded`, `paginateDecoded` decode with a schema                                                           |
| `paginate` follows every page                                   | It stops at `maxPages` (100 by default) and fails beyond it                                                                                                   |
| `getOctokit("")` throws without a token                         | The client sends anonymous requests                                                                                                                           |
| A missing required input throws a defect                        | `getInput` and `getMultilineInput` fail with `ActionInputError` `Missing`                                                                                     |
| `setOutput` and `saveState` take `unknown`                      | They take a JSON value                                                                                                                                        |
| `getIDToken` returns a string                                   | It returns a `Redacted` token                                                                                                                                 |
| `ActionClientTest` takes canned Octokit results                 | `ActionClientTest.make({ fetch })` runs the real Octokit over a fake `fetch`                                                                                  |
| `ActionRunnerTest.make` returns record fields and `getFailed()` | It returns `{ layer, recording }`: `recording` holds `outputs`, `state`, `variables` as `Map`s and `failures`, `logs`, `groups`, `secrets`, `paths` as arrays |
| `ActionContextTest` fails `repo` and `issue` from an `Error`    | It takes an `ActionContextError`, the error the live layer fails with                                                                                         |
| `ActionSummaryTest` fails `write` and `clear` from an `Error`   | It takes the description of the `ActionSummaryError` to fail with                                                                                             |
| —                                                               | `decodePayload(schema)` decodes the event payload; `ActionClient.layer` takes Octokit options                                                                 |

The summary builder stays synchronous, as upstream: `addHeading` and the other `add*` methods only fill
an in-memory buffer, and `write` and `clear`, which touch the file, return an Effect.

## License

MIT. The package is a derivative work of `@effect-native/platform-github`: [LICENSE](LICENSE) keeps its copyright notices, Effectful Technologies Inc and the effect-native contributors, next to Computis.
