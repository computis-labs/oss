import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import {
  isInsideBroadEffectHandler,
  isTagMember,
  tagMemberFromComparison,
} from "./anti-slop/tagged-values.ts";

export const noManualTagComparisonRule = defineRule({
  create: (context) => ({
    BinaryExpression: (node: ESTree.BinaryExpression) => {
      if (
        tagMemberFromComparison(node) === undefined ||
        isInsideBroadEffectHandler(node)
      ) {
        return;
      }
      context.report({ messageId: "manualComparison", node });
    },
    SwitchStatement: (node: ESTree.SwitchStatement) => {
      if (!isTagMember(node.discriminant) || isInsideBroadEffectHandler(node)) {
        return;
      }
      context.report({ messageId: "manualSwitch", node });
    },
  }),
  meta: {
    docs: {
      description:
        "Use Effect Match or Predicate helpers instead of manually branching on _tag.",
    },
    messages: {
      manualComparison:
        "Use Match.tag/Match.tags for tagged-value branching, or Predicate.isTagged for a simple reusable predicate.",
      manualSwitch:
        "Use Match.value(value).pipe(Match.tag/Match.tags/Match.tagsExhaustive) or the tagged enum `$match` helper instead of switching on `_tag`.",
    },
    schema: [],
    type: "problem",
  },
});
