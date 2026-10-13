import { definePlugin, defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const exits = (statement: ESTree.Statement): boolean => {
  if (
    statement.type === "ReturnStatement" ||
    statement.type === "ThrowStatement" ||
    statement.type === "ContinueStatement"
  ) {
    return true;
  }

  if (statement.type === "IfStatement") {
    return (
      statement.alternate !== null && exits(statement.consequent) && exits(statement.alternate)
    );
  }

  if (statement.type === "SwitchStatement") {
    return (
      statement.cases.some((switchCase) => switchCase.test === null) &&
      statement.cases.every(
        (switchCase) => switchCase.consequent.length === 0 || endsInExit(switchCase.consequent),
      )
    );
  }

  return statement.type === "BlockStatement" && endsInExit(statement.body);
};

const endsInExit = (statements: readonly ESTree.Statement[]): boolean => {
  const last = statements.at(-1);

  return last !== undefined && exits(last);
};

const isGuard = (statement: ESTree.Statement) =>
  statement.type === "IfStatement" && statement.alternate === null && exits(statement.consequent);

const preferEarlyReturn = defineRule({
  create: (context) => ({
    IfStatement: (node: ESTree.IfStatement) => {
      if (
        node.alternate !== null ||
        node.consequent.type !== "BlockStatement" ||
        exits(node.consequent)
      ) {
        return;
      }

      const guard = node.consequent.body.find(isGuard);

      if (guard === undefined) {
        return;
      }

      context.report({ messageId: "nestedGuard", node: guard });
    },
  }),
  meta: {
    docs: {
      description:
        "Disallow a guard clause nested in an `if` block that falls through. Lift the guard so the main path stays flat.",
    },
    messages: {
      nestedGuard:
        "Lift this guard out of the enclosing `if`: join both conditions into one top-level guard, or return early on the opposite condition, so the main path stays flat.",
    },
    schema: [],
    type: "suggestion",
  },
});

export default definePlugin({
  meta: { name: "control-flow-policy" },
  rules: { "prefer-early-return": preferEarlyReturn },
});
