import { definePlugin, defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const EFFECT_RUNTIME_METHODS = new Set([
  "runCallback",
  "runFork",
  "runPromise",
  "runPromiseExit",
  "runSync",
  "runSyncExit",
]);

const noManualEffectRuntime = defineRule({
  create: (context) => ({
    CallExpression: (node: ESTree.CallExpression) => {
      const { callee } = node;

      if (callee.type !== "MemberExpression") {
        return;
      }

      const { object, property } = callee;

      if (object.type !== "Identifier" || property.type !== "Identifier") {
        return;
      }

      const isEffectRunner = object.name === "Effect" && EFFECT_RUNTIME_METHODS.has(property.name);
      const isManagedRuntime = object.name === "ManagedRuntime" && property.name === "make";

      if (isEffectRunner || isManagedRuntime) {
        context.report({ messageId: "noManualRuntime", node: callee });
      }
    },
  }),
  meta: {
    docs: {
      description:
        "Disallow manually creating or running Effect runtimes in tests; use @effect/vitest.",
    },
    messages: {
      noManualRuntime:
        "Do not run Effects manually in tests. Use it.effect(...) from @effect/vitest and provide dependencies via test layers.",
    },
    schema: [],
    type: "problem",
  },
});

export default definePlugin({
  meta: { name: "effect-test-policy" },
  rules: { "no-manual-effect-runtime": noManualEffectRuntime },
});
