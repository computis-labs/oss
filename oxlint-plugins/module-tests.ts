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

const guardName = /^require[A-Z]/u;

const guardIdentifier = (node: ESTree.Expression): ESTree.Node | undefined => {
  const target = node.type === "CallExpression" ? node.callee : node;
  if (target.type === "Identifier") {
    return guardName.test(target.name) ? target : undefined;
  }
  if (
    target.type === "MemberExpression" &&
    !target.computed &&
    target.property.type === "Identifier"
  ) {
    return guardName.test(target.property.name) ? target.property : undefined;
  }
  return undefined;
};

const noRouteGuards = defineRule({
  create: (context) => ({
    YieldExpression: (node: ESTree.YieldExpression) => {
      if (!node.delegate || node.argument === null) {
        return;
      }
      const guard = guardIdentifier(node.argument);
      if (guard === undefined) {
        return;
      }
      context.report({ messageId: "routeGuard", node: guard });
    },
  }),
  meta: {
    docs: {
      description:
        "Keep require* access guards out of route handlers; the route group's middleware runs them.",
    },
    messages: {
      routeGuard:
        "Do not yield a require* guard in a route handler. Run the check in the route group's middleware (apps/backend/src/http/middleware) and add it to the contract with .middleware(...).",
    },
    schema: [],
    type: "problem",
  },
});

export default definePlugin({
  meta: { name: "layout-policy" },
  rules: { "module-tests": moduleTests, "no-route-guards": noRouteGuards },
});
