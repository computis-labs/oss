import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import antiSlop from "ultracite/oxlint/anti-slop";

export default defineConfig({
  extends: [core],
  jsPlugins: [
    ...(antiSlop.jsPlugins ?? []),
    "./oxlint-plugins/no-manual-effect-runtime-in-tests.ts",
    "./oxlint-plugins/no-single-use-helpers.ts",
    "./oxlint-plugins/no-discarded-iife.ts",
    "./oxlint-plugins/prefer-when-defined.ts",
    "./oxlint-plugins/return-types-by-branch.ts",
    "./oxlint-plugins/require-named-generator.ts",
    "./oxlint-plugins/no-direct-tag-access.ts",
    "./oxlint-plugins/require-tagged-error-code.ts",
    "./oxlint-plugins/no-unknown-narrowing.ts",
    "./oxlint-plugins/no-test-imports.ts",
    "./oxlint-plugins/no-let.ts",
    "./oxlint-plugins/no-effect-module-alias.ts",
    "./oxlint-plugins/prefer-early-return.ts",
  ],
  options: { typeAware: true, typeCheck: true },
  overrides: [
    {
      files: [
        "packages/effect-xml/**",
        "packages/effect-md/**",
        "packages/effect-pdf/**",
        "packages/effect-github/**",
        "packages/effect-eval/**",
      ],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: [
                  "@computis/**",
                  "!@computis/effect-xml",
                  "!@computis/effect-xml/**",
                  "!@computis/effect-md",
                  "!@computis/effect-md/**",
                  "!@computis/effect-pdf",
                  "!@computis/effect-pdf/**",
                  "!@computis/effect-github",
                  "!@computis/effect-github/**",
                  "!@computis/effect-eval",
                  "!@computis/effect-eval/**",
                ],
                message:
                  "A public package imports only the public packages: effect-xml, effect-md, effect-pdf, effect-github, effect-eval.",
              },
            ],
          },
        ],
      },
    },
    {
      excludeFiles: [
        "packages/effect-xml/src/bin.ts",
        "packages/effect-md/src/bin.ts",
        "packages/effect-pdf/src/worker.ts",
        "packages/effect-github/src/action.ts",
      ],
      files: [
        "packages/effect-xml/src/**",
        "packages/effect-md/src/**",
        "packages/effect-pdf/src/**",
        "packages/effect-github/src/**",
        "packages/effect-eval/src/**",
      ],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: [
                  "@computis/**",
                  "!@computis/effect-xml",
                  "!@computis/effect-xml/**",
                  "!@computis/effect-md",
                  "!@computis/effect-md/**",
                  "!@computis/effect-pdf",
                  "!@computis/effect-pdf/**",
                  "!@computis/effect-github",
                  "!@computis/effect-github/**",
                  "!@computis/effect-eval",
                  "!@computis/effect-eval/**",
                ],
                message:
                  "A public package imports only the public packages: effect-xml, effect-md, effect-pdf, effect-github, effect-eval.",
              },
              {
                group: ["@effect/platform-*", "@effect/platform-*/**"],
                message:
                  "A public package runs on any Effect platform: only its entry file loads one, and the caller provides the services.",
              },
              {
                group: ["node:*"],
                message:
                  "A public package runs on any Effect platform: take files, paths and processes from the Effect services instead of Node built-ins.",
              },
            ],
          },
        ],
      },
    },
    {
      files: ["**/*.{spec,test}.{ts,tsx}"],
      rules: {
        "anti-slop/no-unknown-parameters": "off",
        "anti-slop/no-unsafe-dictionary-type": "off",
      },
    },
    {
      excludeFiles: ["**/*.{spec,test}.{ts,tsx}"],
      files: ["packages/**/*.{ts,tsx}"],
      rules: { "narrowing-policy/no-unknown-narrowing": "error" },
    },
    { files: ["packages/**/*.{ts,tsx}"], rules: { "test-boundary/no-test-imports": "error" } },
    { files: ["packages/effect-eval/src/index.ts"], rules: { "oxc/no-barrel-file": "off" } },
    {
      files: ["**/*.{test,spec,fixtures}.{ts,tsx}"],
      rules: {
        "generator-policy/require-named-generator": ["error", { allowUnnamedGenerators: true }],
      },
    },
    {
      files: ["**/*.{test,spec,fixtures}.{ts,tsx}"],
      rules: { "effect-test-policy/no-manual-effect-runtime": "error" },
    },
    {
      files: ["packages/**/*.{ts,tsx}"],
      rules: { "helper-policy/no-single-use-helpers": "error" },
    },
    {
      files: ["packages/**/*.test.{ts,tsx}", "packages/**/tests/**/*.{ts,tsx}"],
      rules: { "helper-policy/no-single-use-helpers": ["error", { checkConstants: false }] },
    },
  ],
  plugins: ["typescript"],
  rules: {
    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": ["error", { allowInTypeGuards: true }],
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-readable-spacing": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
    "control-flow-policy/prefer-early-return": "error",
    "effect-import-policy/no-effect-module-alias": "error",
    "effect-tag-policy/no-direct-tag-access": "error",
    "error-code-policy/require-tagged-error-code": "error",
    "func-names": "off",
    "function-policy/no-discarded-iife": "error",
    "generator-policy/require-named-generator": "error",
    "jsdoc/check-tag-names": ["error", { definedTags: ["effect-leakable-service"] }],
    "no-shadow": ["error", { allow: ["it"] }],
    "object-policy/prefer-when-defined": "error",
    "return-type-policy/by-branch": "error",
    "typescript/consistent-indexed-object-style": "off",
    "typescript/no-floating-promises": "error",
    "typescript/no-unsafe-assignment": "error",
    "typescript/only-throw-error": [
      "error",
      { allow: [{ from: "package", name: "Redirect", package: "@tanstack/router-core" }] },
    ],
    "unicorn/consistent-function-scoping": "off",
    "unicorn/no-immediate-mutation": "off",
    "unicorn/prefer-reflect-apply": "off",
    "unicorn/throw-new-error": "off",
    "variable-policy/no-let": "error",
  },
});
