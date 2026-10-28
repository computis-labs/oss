import { Array, Config, Effect, Option } from "effect";
import type { Schema } from "effect";
import { isList, isRecord, isText } from "./json.ts";

export interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
}

export interface Privacy {
  readonly rules: readonly Rule[];
  readonly denylist?: Config.Config<readonly string[]>;
}

export interface Finding {
  readonly case: string;
  readonly path: string;
  readonly rule: string;
}

const DENYLIST_SEPARATOR = ",";

export const denylist = (name: string): Config.Config<readonly string[]> =>
  Config.String(name).pipe(
    Config.map((value) =>
      value
        .split(DENYLIST_SEPARATOR)
        .map((token) => token.trim().toLowerCase())
        .filter((token) => token.length > 0),
    ),
  );

const textsOf = (value: Schema.Json, path: string): readonly (readonly [string, string])[] => {
  if (isText(value)) {
    return [[path, value]];
  }

  if (isList(value)) {
    return value.flatMap((item, index) => textsOf(item, `${path}[${String(index)}]`));
  }

  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, item]) =>
      textsOf(item, path === "" ? key : `${path}.${key}`),
    );
  }

  return [];
};

export const scan = (
  id: string,
  value: Schema.Json,
  options: { readonly rules: readonly Rule[]; readonly denylist: readonly string[] },
): readonly Finding[] =>
  textsOf(value, "").flatMap(([path, text]) => [
    ...options.rules
      .filter((rule) => text.search(rule.pattern) !== -1)
      .map((rule) => ({ case: id, path, rule: rule.name })),
    ...options.denylist
      .filter((token) => text.toLowerCase().includes(token))
      .map((token) => ({ case: id, path, rule: `denylist: ${token}` })),
  ]);

export const resolveDenylist = (privacy: Privacy) =>
  privacy.denylist === undefined
    ? Effect.succeed<readonly string[]>([])
    : Config.option(privacy.denylist).pipe(Effect.map(Option.getOrElse(Array.empty<string>)));
