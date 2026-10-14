import { existsSync } from "node:fs";
import path from "node:path";
import { definePlugin, defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const moduleTests = defineRule({
  create: (context) => ({
    Program: (program: ESTree.Program) => {
      const { dir, name } = path.parse(context.filename);
      const testFile = `${name}.test.ts`;
      if (existsSync(path.join(dir, testFile))) {
        return;
      }
      context.report({ data: { testFile }, messageId: "missingTest", node: program });
    },
  }),
  meta: {
    docs: {
      description:
        "Require a sibling <name>.test.ts next to each backend module service, repository, and middleware.",
    },
    messages: {
      missingTest:
        "This file has no test. Write {{testFile}} next to it, following apps/backend/src/test/AGENTS.md.",
    },
    schema: [],
    type: "problem",
  },
});

export default definePlugin({
  meta: { name: "layout-policy" },
  rules: { "module-tests": moduleTests },
});
