import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import {
  isInsideBroadEffectHandler,
  isReasonTagMember,
  isTagMember,
  tagMemberFromComparison,
} from "./anti-slop/tagged-values.ts";

export const noManualEffectErrorTagRule = defineRule({
  create: (context) => ({
    BinaryExpression: (node: ESTree.BinaryExpression) => {
      const tagMember = tagMemberFromComparison(node);
      if (tagMember === undefined || !isInsideBroadEffectHandler(node)) {
        return;
      }
      context.report({
        messageId: isReasonTagMember(tagMember) ? "reason" : "tag",
        node,
      });
    },
    SwitchStatement: (node: ESTree.SwitchStatement) => {
      if (
        !isTagMember(node.discriminant) ||
        !isInsideBroadEffectHandler(node)
      ) {
        return;
      }
      context.report({
        messageId: isReasonTagMember(node.discriminant) ? "reason" : "tag",
        node,
      });
    },
  }),
  meta: {
    docs: {
      description:
        "Use Effect tagged error handlers instead of manually branching on _tag in a broad catch handler.",
    },
    messages: {
      tag: "Use Effect.catchTag or Effect.catchTags instead of manually discriminating a tagged error in a broad Effect catch handler.",
      reason:
        "Use Effect.catchReason or Effect.catchReasons instead of manually discriminating a tagged reason in a broad Effect catch handler.",
    },
    schema: [],
    type: "problem",
  },
});
