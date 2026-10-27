import { getOctokit } from "@actions/github";
import { GitHub } from "@actions/github/lib/utils";
import { whenDefined } from "./object.ts";
import { thrownMessage } from "./thrown-message.ts";
import { Config, Context, Effect, flow, Layer, Option, Redacted, Schema, Stream } from "effect";
import { ActionApiError } from "./errors/action-api-error.ts";

export type Octokit = ReturnType<typeof getOctokit>;

export type OctokitOptions = NonNullable<Parameters<typeof getOctokit>[1]>;

export type RequestParameters = Readonly<Record<string, Schema.Json>>;

export type RestResponse = Omit<Awaited<ReturnType<Octokit["request"]>>, "data"> & {
  readonly data: Schema.Json;
};

export interface PaginateOptions {
  readonly maxPages?: number;
}

export interface ActionClientApi {
  readonly octokit: Octokit;
  readonly call: <A>(
    method: string,
    run: (octokit: Octokit) => Promise<A>,
  ) => Effect.Effect<A, ActionApiError>;
  readonly request: (
    route: string,
    parameters?: RequestParameters,
  ) => Effect.Effect<RestResponse, ActionApiError>;
  readonly graphql: (
    query: string,
    variables?: RequestParameters,
  ) => Effect.Effect<Schema.Json, ActionApiError>;
  readonly paginate: (
    route: string,
    parameters?: RequestParameters,
    options?: PaginateOptions,
  ) => Effect.Effect<readonly Schema.Json[], ActionApiError>;
  readonly requestDecoded: <S extends Schema.Top>(
    schema: S,
    route: string,
    parameters?: RequestParameters,
  ) => Effect.Effect<S["Type"], ActionApiError, S["DecodingServices"]>;
  readonly graphqlDecoded: <S extends Schema.Top>(
    schema: S,
    query: string,
    variables?: RequestParameters,
  ) => Effect.Effect<S["Type"], ActionApiError, S["DecodingServices"]>;
  readonly paginateDecoded: <S extends Schema.Top>(
    schema: S,
    route: string,
    parameters?: RequestParameters,
    options?: PaginateOptions,
  ) => Effect.Effect<readonly S["Type"][], ActionApiError, S["DecodingServices"]>;
}

const defaultMaxPages = 100;

const decodeMaxPages = Schema.decodeUnknownEffect(
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
);

const decodeHttpStatus = Schema.decodeUnknownOption(Schema.Struct({ status: Schema.Number }));

const decodeResponse = <S extends Schema.Top>(schema: S, method: string) =>
  flow(
    Schema.decodeUnknownEffect(schema),
    Effect.mapError(
      (cause) =>
        new ActionApiError({ cause, description: `unexpected response: ${cause.message}`, method }),
    ),
  );

const requestFailed = (method: string) => (cause: unknown) =>
  cause instanceof ActionApiError
    ? cause
    : new ActionApiError({
        cause,
        description: thrownMessage(cause, "the request failed"),
        method,
        ...whenDefined(Option.getOrUndefined(decodeHttpStatus(cause)), ({ status }) => ({
          status,
        })),
      });

const make = (token: Redacted.Redacted, options: OctokitOptions = {}): ActionClientApi => {
  const secret = Redacted.value(token);
  const octokit = secret === "" ? new GitHub(options) : getOctokit(secret, options);

  const call = Effect.fn("ActionClient.call")(function* call<A>(
    method: string,
    run: (client: Octokit) => Promise<A>,
  ) {
    return yield* Effect.tryPromise({
      catch: requestFailed(method),
      try: async () => await run(octokit),
    });
  });

  const request = Effect.fn("ActionClient.request")(function* request(
    route: string,
    parameters?: RequestParameters,
  ) {
    const response = yield* call(route, async (client) => await client.request(route, parameters));
    const data = yield* decodeResponse(Schema.Json, route)(response.data);
    const restResponse: RestResponse = { ...response, data };

    return restResponse;
  });

  const graphql = Effect.fn("ActionClient.graphql")(function* graphql(
    query: string,
    variables?: RequestParameters,
  ) {
    const data = yield* call("graphql", async (client) => await client.graphql(query, variables));

    return yield* decodeResponse(Schema.Json, "graphql")(data);
  });

  const paginate = Effect.fn("ActionClient.paginate")(function* paginate(
    route: string,
    parameters?: RequestParameters,
    paginateOptions: PaginateOptions = {},
  ) {
    const maxPages = yield* decodeMaxPages(paginateOptions.maxPages ?? defaultMaxPages).pipe(
      Effect.mapError(
        (cause) =>
          new ActionApiError({
            cause,
            description: `maxPages must be a positive integer: ${cause.message}`,
            method: route,
          }),
      ),
    );

    const iterator = yield* Effect.try({
      catch: requestFailed(route),
      try: () => octokit.paginate.iterator(route, parameters),
    });

    const pages = yield* Stream.fromAsyncIterable(iterator, requestFailed(route)).pipe(
      Stream.take(maxPages + 1),
      Stream.runCollect,
    );

    if (pages.length > maxPages) {
      return yield* new ActionApiError({
        description: `more than ${maxPages} pages`,
        method: route,
      });
    }

    return yield* decodeResponse(
      Schema.Array(Schema.Json),
      route,
    )(pages.flatMap((page) => page.data));
  });

  return {
    call,
    graphql,
    graphqlDecoded: Effect.fn("ActionClient.graphqlDecoded")(function* graphqlDecoded<
      S extends Schema.Top,
    >(schema: S, query: string, variables?: RequestParameters) {
      const data = yield* graphql(query, variables);

      return yield* decodeResponse(schema, "graphql")(data);
    }),
    octokit,
    paginate,
    paginateDecoded: Effect.fn("ActionClient.paginateDecoded")(function* paginateDecoded<
      S extends Schema.Top,
    >(schema: S, route: string, parameters?: RequestParameters, paginateOptions?: PaginateOptions) {
      const items = yield* paginate(route, parameters, paginateOptions);

      return yield* decodeResponse(Schema.Array(schema), route)(items);
    }),
    request,
    requestDecoded: Effect.fn("ActionClient.requestDecoded")(function* requestDecoded<
      S extends Schema.Top,
    >(schema: S, route: string, parameters?: RequestParameters) {
      const { data } = yield* request(route, parameters);

      return yield* decodeResponse(schema, route)(data);
    }),
  };
};

export class ActionClient extends Context.Service<ActionClient, ActionClientApi>()(
  "@computis/effect-github/ActionClient",
) {
  static readonly layer = (token: Redacted.Redacted, options?: OctokitOptions) =>
    Layer.sync(ActionClient, () => make(token, options));

  static readonly layerConfig = Layer.effect(
    ActionClient,
    Effect.gen(function* makeActionClientFromConfig() {
      const token = yield* Config.Redacted("INPUT_GITHUB_TOKEN").pipe(
        Config.orElse(() => Config.Redacted("GITHUB_TOKEN")),
        Config.withDefault(Redacted.make("")),
      );

      return make(token);
    }),
  );
}

const client = Effect.service(ActionClient);

export const octokit: Effect.Effect<Octokit, never, ActionClient> = client.pipe(
  Effect.map((service) => service.octokit),
);

export const request = (route: string, parameters?: RequestParameters) =>
  client.pipe(Effect.flatMap((service) => service.request(route, parameters)));

export const graphql = (query: string, variables?: RequestParameters) =>
  client.pipe(Effect.flatMap((service) => service.graphql(query, variables)));

export const paginate = (
  route: string,
  parameters?: RequestParameters,
  options?: PaginateOptions,
) => client.pipe(Effect.flatMap((service) => service.paginate(route, parameters, options)));

export const { layer, layerConfig } = ActionClient;

export const call = <A>(method: string, run: (octokit: Octokit) => Promise<A>) =>
  client.pipe(Effect.flatMap((service) => service.call(method, run)));

export const requestDecoded = <S extends Schema.Top>(
  schema: S,
  route: string,
  parameters?: RequestParameters,
) => client.pipe(Effect.flatMap((service) => service.requestDecoded(schema, route, parameters)));

export const graphqlDecoded = <S extends Schema.Top>(
  schema: S,
  query: string,
  variables?: RequestParameters,
) => client.pipe(Effect.flatMap((service) => service.graphqlDecoded(schema, query, variables)));

export const paginateDecoded = <S extends Schema.Top>(
  schema: S,
  route: string,
  parameters?: RequestParameters,
  options?: PaginateOptions,
) =>
  client.pipe(
    Effect.flatMap((service) => service.paginateDecoded(schema, route, parameters, options)),
  );
