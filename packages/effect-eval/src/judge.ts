import {
  Cause,
  Effect,
  Exit,
  Match,
  pipe,
  Option,
  Predicate,
  Ref,
  Result,
  Schema,
  SchemaAST,
  SchemaRepresentation,
  SchemaTransformation,
} from "effect";
import { LanguageModel, Prompt } from "effect/ai";
import type { Agreement } from "./agreement.ts";
import type { Case } from "./dataset.ts";
import { canonical, sha256 } from "./json.ts";
import { Judgements } from "./judgements.ts";
import { ObservationSchema, actualStates, expectedStates } from "./observation.ts";
import type { Observation } from "./observation.ts";
import * as Observations from "./observation.ts";
import type { Expectation, Scorer } from "./scorer.ts";
import { present } from "./scorer.ts";
import { whenDefined } from "./object.ts";
import { Meter, add, empty, labelled, observe, recordUsage } from "./usage.ts";
import type { Variant } from "./variant.ts";

const LINE_BREAK = "\n";
const JUDGED = "judged";

export interface JudgeOptions<A, O, Rubric, RE, RIn> {
  readonly name: string;
  readonly model: Variant<LanguageModel.LanguageModel, RE, RIn>;
  readonly prompt: (input: Case<A>, output: O) => Prompt.RawInput;
  readonly rubric: Schema.Codec<Rubric, { readonly [key: string]: Schema.Json }>;
  readonly agreement: (verdict: Rubric) => Agreement;
  readonly expected?: (input: A) => Expectation<string>;
  readonly show?: (output: O) => string;
  readonly note?: (verdict: Rubric) => string;
  readonly version?: string;
}

const isJson = Schema.is(Schema.Json);

const encodePrompt = Schema.encodeEffect(Schema.toCodecJson(Prompt.Prompt));

const encodeResult = Schema.encodeEffect(ObservationSchema);
const decodeResult = Schema.decodeUnknownEffect(ObservationSchema);
const sameResult = Schema.toEquivalence(ObservationSchema);

type Defaults = readonly (readonly [string, Schema.Json])[];

const PROBE = "probe";
const CACHE_FORMAT = "observation-2";

const getterTags = {
  omit: "TransformOptional",
  passthrough: "Passthrough",
  withDefault: "TransformOptionalEffect",
} as const;

const defaultsOf = (
  ast: SchemaAST.AST,
  path: string,
  ownEncoding = true,
): Effect.Effect<Defaults, Cause.NoSuchElementError> => {
  const within = (children: readonly (readonly [SchemaAST.AST, string])[]) =>
    pipe(
      children,
      Effect.forEach(([child, at]) => defaultsOf(child, at)),
      Effect.map((found) => found.flat()),
    );

  if (
    (ownEncoding && ast.encoding !== undefined) ||
    SchemaAST.isSuspend(ast) ||
    SchemaAST.isDeclaration(ast)
  ) {
    return Effect.fail(new Cause.NoSuchElementError());
  }

  if (SchemaAST.isObjects(ast)) {
    return Effect.all([
      pipe(
        ast.propertySignatures,
        Effect.forEach((property): Effect.Effect<Defaults, Cause.NoSuchElementError> => {
          const at = `${path}/${String(property.name)}`;

          if (property.type.encoding === undefined) {
            return defaultsOf(property.type, at);
          }

          const [link, ...others] = property.type.encoding;

          const decodingDefault =
            SchemaAST.isOptional(link.to) &&
            SchemaTransformation.isTransformation(link.transformation) &&
            Predicate.isTagged(link.transformation.decode, getterTags.withDefault) &&
            (Predicate.isTagged(link.transformation.encode, getterTags.passthrough) ||
              Predicate.isTagged(link.transformation.encode, getterTags.omit));

          if (others.length > 0 || !decodingDefault) {
            return Effect.fail(new Cause.NoSuchElementError());
          }

          return Schema.decodeUnknownEffect(
            Schema.Struct({ [PROBE]: Schema.make<Schema.Codec<unknown, unknown>>(property.type) }),
          )({}).pipe(
            Effect.option,
            Effect.map(Option.flatMap((decoded) => Option.liftPredicate(decoded[PROBE], isJson))),
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new Cause.NoSuchElementError()),
                onSome: (value) =>
                  defaultsOf(property.type, at, false).pipe(
                    Effect.map((nested) => [[at, value] as const, ...nested]),
                  ),
              }),
            ),
          );
        }),
        Effect.map((found) => found.flat()),
      ),
      within(ast.indexSignatures.map((index) => [index.type, `${path}/*`] as const)),
    ]).pipe(Effect.map(([own, nested]) => [...own, ...nested]));
  }

  if (SchemaAST.isArrays(ast)) {
    return within(
      [...ast.elements, ...ast.rest].map((child, index) => [child, `${path}/${String(index)}`]),
    );
  }

  if (SchemaAST.isUnion(ast)) {
    return within(ast.types.map((child, index) => [child, `${path}|${String(index)}`]));
  }

  return Effect.succeed([]);
};

export const make =
  <A, O, Rubric, RE, RIn>(options: JudgeOptions<A, O, Rubric, RE, RIn>): Scorer<A, O, RIn> =>
  (input, outcome) => {
    const expectation = options.expected?.(input.input) ?? present(JUDGED);

    const expectedText = Match.valueTags(expectation, {
      Absent: () => "",
      Present: ({ value }) => value,
      Unknown: () => "?",
    });

    const key = `judge:${options.name}`;
    const observationKey = Observations.keyOf(key);

    const ask = (prompt: Prompt.RawInput) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* askJudge() {
          const nested = yield* Ref.make(empty);

          const { exit, usage } = yield* observe(
            restore(
              LanguageModel.generateObject({
                objectName: options.name,
                prompt,
                schema: options.rubric,
              }).pipe(
                Effect.provide(options.model.layer),
                Effect.provideService(Meter, {
                  record: (recorded) => Ref.update(nested, (current) => add(current, recorded)),
                }),
              ),
            ),
          );

          const tracked = yield* Ref.get(nested);
          yield* recordUsage(labelled(tracked.calls > 0 ? tracked : usage, key));

          return yield* exit;
        }),
      ).pipe(Effect.map((response) => response.value));

    const judged = (output: O, actual: string) =>
      Effect.gen(function* judgeOutput() {
        const memory = yield* Judgements;
        const prompt = options.prompt(input, output);

        const shown = isJson(output)
          ? Option.some<Schema.Json>(output)
          : Option.fromNullishOr(options.show?.(output));

        const rubric = yield* Effect.try(() =>
          SchemaRepresentation.toJson(SchemaRepresentation.toRepresentation(options.rubric.ast)),
        ).pipe(Effect.option);

        const defaults = yield* defaultsOf(options.rubric.ast, "").pipe(Effect.option);

        const fingerprinted =
          (Option.isSome(defaults) && Option.isSome(rubric)) || options.version !== undefined;

        const hash: Option.Option<string> = yield* Option.match(
          shown.pipe(Option.filter(() => fingerprinted)),
          {
            onNone: () => Effect.succeedNone,
            onSome: (described) =>
              encodePrompt(Prompt.make(prompt)).pipe(
                Effect.flatMap((encoded) =>
                  sha256(
                    canonical({
                      actual,
                      cache: CACHE_FORMAT,
                      case: input.id,
                      defaults: Option.match(defaults, {
                        onNone: () => null,
                        onSome: (fallbacks) => fallbacks.map(([path, value]) => [path, value]),
                      }),
                      expected: expectedText,
                      key,
                      model: options.model.name,
                      output: described,
                      prompt: encoded,
                      rubric: Option.getOrNull(rubric),
                      tags: input.tags,
                      version: options.version ?? null,
                    }),
                  ),
                ),
                Effect.option,
              ),
          },
        );

        const stored = yield* Option.match(
          hash.pipe(
            Option.flatMap((value) =>
              memory.lookup(key, value).pipe(Option.map((result) => ({ result, value }))),
            ),
          ),
          {
            onNone: () => Effect.succeedNone,
            onSome: ({ result, value }) =>
              decodeResult(result).pipe(
                Effect.tap(() => memory.record({ hash: value, key, result }).pipe(Effect.ignore)),
                Effect.option,
              ),
          },
        );

        if (Option.isSome(stored)) {
          return stored.value;
        }

        const verdict = yield* ask(prompt);

        const result: Observation = Observations.compared({
          agreement: options.agreement(verdict),
          detail: {
            actual,
            expected: expectedText,
            ...whenDefined(options.note, (note) => ({ note: note(verdict) })),
          },
          key: observationKey,
          tags: input.tags,
        });

        const lossless = yield* encodeResult(result).pipe(
          Effect.flatMap((encoded) =>
            decodeResult(encoded).pipe(
              Effect.map((decoded) =>
                sameResult(decoded, result) ? Option.liftPredicate(encoded, isJson) : Option.none(),
              ),
            ),
          ),
          Effect.orElseSucceed(() => Option.none<Schema.Json>()),
        );

        yield* Option.match(Option.all({ encoded: lossless, value: hash }), {
          onNone: () => Effect.void,
          onSome: ({ encoded, value }) =>
            memory.record({ hash: value, key, result: encoded }).pipe(Effect.ignore),
        });

        return result;
      });

    return Result.match(outcome, {
      onFailure: (failure) =>
        Effect.succeed([
          Observations.errored(observationKey, failure, {
            detail: { actual: "", expected: expectedText },
            expected: Match.valueTags(expectation, {
              Absent: () => expectedStates.absent,
              Present: () => expectedStates.present,
              Unknown: () => expectedStates.unknown,
            }),
            tags: input.tags,
          }),
        ]),
      onSuccess: (output) => {
        const actual = options.show?.(output) ?? JUDGED;

        return Match.valueTags(expectation, {
          Absent: () =>
            Effect.succeed([
              Observations.make({
                actual: actualStates.present,
                detail: { actual, expected: expectedText },
                expected: expectedStates.absent,
                key: observationKey,
                tags: input.tags,
              }),
            ]),
          Present: () =>
            judged(output, actual).pipe(
              Effect.exit,
              Effect.flatMap((exit) =>
                Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)
                  ? Effect.orDie(Effect.failCause(exit.cause))
                  : Effect.succeed(exit),
              ),
              Effect.map((exit) => [
                Exit.match(exit, {
                  onFailure: (cause) =>
                    Observations.errored(
                      observationKey,
                      `judge: ${Cause.pretty(cause).split(LINE_BREAK)[0] ?? ""}`,
                      {
                        detail: { actual, expected: expectedText },
                        expected: expectedStates.present,
                        tags: input.tags,
                      },
                    ),
                  onSuccess: (result) => result,
                }),
              ]),
            ),
          Unknown: () =>
            Effect.succeed([
              Observations.make({
                actual: actualStates.present,
                detail: { actual, expected: expectedText },
                expected: expectedStates.unknown,
                key: observationKey,
                tags: input.tags,
              }),
            ]),
        });
      },
    });
  };
