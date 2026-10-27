import { describe, expect, it } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { ActionClient } from "../src/action-client.ts";
import { ActionApiError } from "../src/errors/action-api-error.ts";
import * as ActionClientTest from "../src/testing/action-client-test.ts";

const github =
  (handler: (url: URL) => Response): typeof fetch =>
  async (input) =>
    await Promise.resolve(handler(new URL(input instanceof Request ? input.url : input)));

const Comment = Schema.Struct({ body: Schema.String, id: Schema.Number });

describe("ActionClient", () => {
  it.effect("decodes the data of a REST response", () =>
    Effect.gen(function* () {
      const client = yield* ActionClient;

      const comment = yield* client.requestDecoded(
        Comment,
        "GET /repos/{owner}/{repo}/issues/comments/{comment_id}",
        { comment_id: 7, owner: "computis-labs", repo: "computis" },
      );

      expect(comment).toStrictEqual({ body: "Looks good", id: 7 });
    }).pipe(
      Effect.provide(
        ActionClientTest.make({
          fetch: github((url) =>
            url.pathname === "/repos/computis-labs/computis/issues/comments/7"
              ? Response.json({ body: "Looks good", id: 7, user: { login: "octocat" } })
              : Response.json({ message: "Not Found" }, { status: 404 }),
          ),
        }),
      ),
    ),
  );

  it.effect("returns the whole response of a REST request", () =>
    Effect.gen(function* () {
      const client = yield* ActionClient;

      const response = yield* client.request(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        {
          body: "Legal review",
          issue_number: 12,
          owner: "computis-labs",
          repo: "computis",
        },
      );

      expect(response.status).toBe(201);
      expect(response.headers["x-ratelimit-remaining"]).toBe("4999");
      expect(response.data).toStrictEqual({ body: "Legal review", id: 99 });
    }).pipe(
      Effect.provide(
        ActionClientTest.make({
          fetch: github(() =>
            Response.json(
              { body: "Legal review", id: 99 },
              { headers: { "x-ratelimit-remaining": "4999" }, status: 201 },
            ),
          ),
        }),
      ),
    ),
  );

  it.effect("reports the HTTP status of a rejected request", () =>
    Effect.gen(function* () {
      const client = yield* ActionClient;

      const error = yield* client
        .requestDecoded(Comment, "GET /repos/{owner}/{repo}/issues/comments/{comment_id}", {
          comment_id: 7,
          owner: "computis-labs",
          repo: "computis",
        })
        .pipe(Effect.flip);

      expect(error.status).toBe(429);
      expect(error.isRateLimited).toBe(true);
    }).pipe(
      Effect.provide(
        ActionClientTest.make({
          fetch: github(() => Response.json({ message: "Slow down" }, { status: 429 })),
        }),
      ),
    ),
  );

  it.effect("fails when the response does not match the schema", () =>
    Effect.gen(function* () {
      const client = yield* ActionClient;

      const error = yield* client
        .requestDecoded(Comment, "GET /repos/{owner}/{repo}/issues/comments/{comment_id}", {
          comment_id: 7,
          owner: "computis-labs",
          repo: "computis",
        })
        .pipe(Effect.flip);

      expect(error.status).toBeUndefined();
      expect(error.description).toMatch(/^unexpected response: /u);
    }).pipe(
      Effect.provide(
        ActionClientTest.make({
          fetch: github(() => Response.json({ body: "Looks good", id: "7" })),
        }),
      ),
    ),
  );

  it.effect("sends requests without credentials when no token is set", () =>
    Effect.gen(function* () {
      const client = yield* ActionClient;

      const response = yield* client.request("GET /repos/{owner}/{repo}", {
        owner: "computis-labs",
        repo: "oss",
      });

      expect(response.data).toStrictEqual({ authorization: null });
    }).pipe(
      Effect.provide(
        ActionClient.layer(Redacted.make(""), {
          request: {
            fetch: async (_input: string | URL | Request, init?: RequestInit) =>
              await Promise.resolve(
                Response.json({ authorization: new Headers(init?.headers).get("authorization") }),
              ),
          },
        }),
      ),
    ),
  );

  it.effect("follows the Link header across every page", () =>
    Effect.gen(function* () {
      const client = yield* ActionClient;

      const comments = yield* client.paginateDecoded(
        Comment,
        "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
        { issue_number: 12, owner: "computis-labs", repo: "computis" },
      );

      expect(comments.map(({ id }) => id)).toStrictEqual([1, 2]);
    }).pipe(
      Effect.provide(
        ActionClientTest.make({
          fetch: github((url) =>
            url.searchParams.get("page") === "2"
              ? Response.json([{ body: "second", id: 2 }])
              : Response.json([{ body: "first", id: 1 }], {
                  headers: {
                    link: `<https://api.github.com/repos/computis-labs/computis/issues/12/comments?page=2>; rel="next"`,
                  },
                }),
          ),
        }),
      ),
    ),
  );

  it.effect("stops after the page limit when every page links to another", () => {
    const requestedPages = Array.of<string>();

    return Effect.gen(function* () {
      const client = yield* ActionClient;

      const error = yield* client
        .paginate(
          "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
          { issue_number: 12, owner: "computis-labs", repo: "computis" },
          { maxPages: 3 },
        )
        .pipe(Effect.flip);

      expect(error.description).toBe("more than 3 pages");
      expect(requestedPages).toHaveLength(4);
    }).pipe(
      Effect.provide(
        ActionClientTest.make({
          fetch: github((url) => {
            const page = Number(url.searchParams.get("page") ?? "1");
            requestedPages.push(String(page));

            return Response.json([{ body: "again", id: page }], {
              headers: {
                link: `<https://api.github.com/repos/computis-labs/computis/issues/12/comments?page=${page + 1}>; rel="next"`,
              },
            });
          }),
        }),
      ),
    );
  });

  it.effect.each([Number.NaN, Number.POSITIVE_INFINITY, 0, 2.5])(
    "rejects a page limit of %s before any request",
    (maxPages) => {
      const requests = Array.of<string>();

      return Effect.gen(function* () {
        const client = yield* ActionClient;

        const error = yield* client
          .paginate(
            "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
            { issue_number: 12, owner: "computis-labs", repo: "computis" },
            { maxPages },
          )
          .pipe(Effect.flip);

        expect(error.description).toMatch(/^maxPages must be a positive integer: /u);
        expect(requests).toStrictEqual([]);
      }).pipe(
        Effect.provide(
          ActionClientTest.make({
            fetch: github((url) => {
              requests.push(url.pathname);

              return Response.json([]);
            }),
          }),
        ),
      );
    },
  );

  it.effect(
    "fails with ActionApiError when Octokit rejects the parameters of a paginated route",
    () =>
      Effect.gen(function* () {
        const client = yield* ActionClient;

        const error = yield* client.paginate("GET /user", { method: null }).pipe(Effect.flip);

        expect(error.method).toBe("GET /user");
      }).pipe(Effect.provide(ActionClientTest.layer)),
  );

  it.effect("returns an ActionApiError the call already failed with unchanged", () =>
    Effect.gen(function* () {
      const client = yield* ActionClient;

      const rateLimited = new ActionApiError({
        description: "secondary rate limit",
        method: "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        status: 403,
      });

      const error = yield* client
        .call("rest.issues.createComment", async () => await Promise.reject(rateLimited))
        .pipe(Effect.flip);

      expect(error).toBe(rateLimited);
    }).pipe(Effect.provide(ActionClientTest.layer)),
  );

  it.effect("fails a REST request whose body is not JSON", () =>
    Effect.gen(function* () {
      const client = yield* ActionClient;

      const error = yield* client
        .request("GET /repos/{owner}/{repo}/zipball/{ref}", {
          owner: "computis-labs",
          ref: "main",
          repo: "oss",
        })
        .pipe(Effect.flip);

      expect(error.method).toBe("GET /repos/{owner}/{repo}/zipball/{ref}");
      expect(error.description).toMatch(/^unexpected response: /u);
    }).pipe(
      Effect.provide(
        ActionClientTest.make({
          fetch: github(
            () =>
              new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
                headers: { "content-type": "application/zip" },
              }),
          ),
        }),
      ),
    ),
  );
});
