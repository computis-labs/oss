import { definePlugin } from "@oxlint/plugins";

import { maxTernaryDepthRule } from "./max-ternary-depth.ts";
import { noConditionalSpreadRule } from "./no-conditional-spread.ts";
import { noInOperatorRule } from "./no-in-operator.ts";
import { noObjectParametersRule } from "./no-object-parameters.ts";

export default definePlugin({
  meta: { name: "anti-slop-core" },
  rules: {
    "max-ternary-depth": maxTernaryDepthRule,
    "no-conditional-spread": noConditionalSpreadRule,
    "no-in-operator": noInOperatorRule,
    "no-object-parameters": noObjectParametersRule,
  },
});
