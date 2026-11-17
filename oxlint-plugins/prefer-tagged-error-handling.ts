import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import { isInsideBroadEffectHandler } from "./anti-slop/tagged-values.ts";

const isPredicateIsTagged = (node: ESTree.Node): boolean =>
  node.type === "MemberExpression" &&
  !node.computed &&
  node.object.type === "Identifier" &&
  node.object.name === "Predicate" &&
  node.property.type === "Identifier" &&
  node.property.name === "isTagged";

const taggedSubject = (
  node: ESTree.CallExpression
): ESTree.Node | undefined => {
  if (isPredicateIsTagged(node.callee) && node.arguments.length === 2) {
    return node.arguments[0];
  }
  if (
    node.callee.type === "CallExpression" &&
    isPredicateIsTagged(node.callee.callee) &&
    node.callee.arguments.length === 1 &&
    node.arguments.length === 1
  ) {
    return node.arguments[0];
  }
  return undefined;
};

const isReasonMember = (node: ESTree.Node): boolean =>
  node.type === "MemberExpression" &&
  !node.computed &&
  node.property.type === "Identifier" &&
  node.property.name === "reason";

export const preferTaggedErrorHandlingRule = defineRule({
  create: (context) => ({
    CallExpression: (node: ESTree.CallExpression) => {
      const subject = taggedSubject(node);
      if (subject === undefined || !isInsideBroadEffectHandler(node)) {
        return;
      }
      context.report({
        messageId: isReasonMember(subject) ? "taggedReason" : "taggedError",
        node,
      });
    },
  }),
  meta: {
    docs: {
      description:
        "Use Effect tagged error handlers instead of `Predicate.isTagged` checks in a broad catch handler.",
    },
    messages: {
      taggedError:
        "Use Effect.catchTag or Effect.catchTags instead of checking the error with `Predicate.isTagged` in a broad Effect catch handler.",
      taggedReason:
        "Use Effect.catchReason or Effect.catchReasons instead of checking the error `reason` with `Predicate.isTagged` in a broad Effect catch handler.",
    },
    schema: [],
    type: "problem",
  },
});
