import { definePlugin, defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const FIXTURES_DIRECTORY = /(?:^|\/)apps\/backend\/src\/test\/fixtures\//u;

const fixturesInHarness = defineRule({
  create: (context) => ({
    Program: (node: ESTree.Program) => {
      if (FIXTURES_DIRECTORY.test(context.physicalFilename)) {
        return;
      }
      context.report({ messageId: "fixturesInHarness", node });
    },
  }),
  meta: {
    docs: {
      description: "Keep shared backend test fixtures in apps/backend/src/test/fixtures.",
    },
    messages: {
      fixturesInHarness:
        "Shared test fixtures live in apps/backend/src/test/fixtures/<domain>.ts. Move these helpers into the file of their domain and import them from #/test/fixtures/<domain>.",
    },
    schema: [],
    type: "problem",
  },
});

export default definePlugin({
  meta: { name: "test-fixture-policy" },
  rules: { "fixtures-in-harness": fixturesInHarness },
});
