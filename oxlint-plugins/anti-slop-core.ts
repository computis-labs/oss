import { definePlugin } from "@oxlint/plugins";

import { maxTernaryDepthRule } from "./max-ternary-depth.ts";
import { noConditionalSpreadRule } from "./no-conditional-spread.ts";
import { noObjectParametersRule } from "./no-object-parameters.ts";

export default definePlugin({
  meta: { name: "anti-slop-core" },
  rules: {
    "max-ternary-depth": maxTernaryDepthRule,
    "no-conditional-spread": noConditionalSpreadRule,
    "no-object-parameters": noObjectParametersRule,
  },
});
