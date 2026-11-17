import { definePlugin } from "@oxlint/plugins";

import { noManualEffectErrorTagRule } from "./no-manual-effect-error-tag.ts";
import { noManualTagComparisonRule } from "./no-manual-tag-comparison.ts";
import { noManualTaggedConstructionRule } from "./no-manual-tagged-construction.ts";
import { noManualTaggedTypeRule } from "./no-manual-tagged-type.ts";
import { noReprovideAmbientServiceRule } from "./no-reprovide-ambient-service.ts";
import { preferEffectMatchRule } from "./prefer-effect-match.ts";
import { preferTaggedErrorHandlingRule } from "./prefer-tagged-error-handling.ts";

export default definePlugin({
  meta: { name: "anti-slop-effect" },
  rules: {
    "no-manual-effect-error-tag": noManualEffectErrorTagRule,
    "no-manual-tag-comparison": noManualTagComparisonRule,
    "no-manual-tagged-construction": noManualTaggedConstructionRule,
    "no-manual-tagged-type": noManualTaggedTypeRule,
    "no-reprovide-ambient-service": noReprovideAmbientServiceRule,
    "prefer-effect-match": preferEffectMatchRule,
    "prefer-tagged-error-handling": preferTaggedErrorHandlingRule,
  },
});
