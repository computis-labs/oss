# Adapted anti-slop rules

Adapted from [K-Mistele/anti-slop](https://github.com/K-Mistele/anti-slop) at commit `b7c1619b4d51b4815e89ba3700a975a6ec54b8c3`, under the [MIT license](./LICENSE).

`../anti-slop-effect.ts` registers these adapted rules:

- `../no-manual-effect-error-tag.ts` comes from `src/effect/rules/no-manual-effect-error-tag.ts`.
- `../no-manual-tag-comparison.ts` comes from `src/effect/rules/no-manual-tag-comparison.ts`.
- `../no-manual-tagged-construction.ts` comes from `src/effect/rules/no-manual-tagged-construction.ts`; its property-name checks are combined in a local predicate.
- `../no-manual-tagged-type.ts` comes from `src/effect/rules/no-manual-tagged-type.ts`.
- `../prefer-effect-match.ts` comes from `src/effect/rules/prefer-effect-match.ts`; it uses an array for the equality-operator membership check.
- `../prefer-tagged-error-handling.ts` comes from `src/effect/rules/prefer-tagged-error-handling.ts`.
- `../no-reprovide-ambient-service.ts` comes from `src/rules/no-reprovide-ambient-service.ts`; it retains the upstream import forms, lexical variable resolution, expression unwrapping and direct-yield scope. It uses per-file `create` state rather than `createOnce`.

`../anti-slop-core.ts` registers the general rules separately from the Effect-specific rules:

- `../max-ternary-depth.ts` comes from `src/rules/max-ternary-depth.ts`; it uses the repository's option predicates and keeps the upstream default maximum depth of 2.
- `../no-conditional-spread.ts` comes from `src/rules/no-conditional-spread.ts`; it retains the upstream spread positions and parenthesis unwrapping, without an automatic fixer.
- `../no-object-parameters.ts` comes from `src/rules/no-object-parameters.ts`; it retains the upstream parameter owners and local alias resolution, including generic substitution and lexical shadowing.

`function-parameters.ts` contains the relevant helpers from `src/shared/function-parameters.ts`. `type-alias-resolution.ts` combines the relevant helpers from `src/shared/type-alias-resolution.ts` and `src/shared/lexical-type-parameters.ts`, without the unused exports or cross-rule environment cache. The rule uses per-file `create` state rather than `createOnce`.

`tagged-values.ts` contains the relevant helpers from `src/effect/shared/tagged-values.ts`. The rules use the repository's plugin registration, string predicate and formatting, without changing the upstream detection scope. Their tests include the upstream examples and additional comparison, reason and callback-boundary cases.
