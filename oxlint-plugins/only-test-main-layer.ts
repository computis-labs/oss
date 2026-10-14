import { definePlugin, defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const TEST_MAIN_LAYER = "testMainLayer";

const onlyTestMainLayer = defineRule({
  create: (context) => ({
    CallExpression: (node: ESTree.CallExpression) => {
      const { callee } = node;

      if (callee.type !== "MemberExpression") {
        return;
      }

      const { object, property } = callee;

      if (object.type !== "Identifier" || object.name !== "it") {
        return;
      }

      if (property.type !== "Identifier" || property.name !== "layer") {
        return;
      }

      const [layer] = node.arguments;

      if (layer === undefined) {
        return;
      }

      const isTestMainLayerCall =
        layer.type === "CallExpression" &&
        layer.callee.type === "Identifier" &&
        layer.callee.name === TEST_MAIN_LAYER;

      if (isTestMainLayerCall) {
        return;
      }

      context.report({ messageId: "onlyTestMainLayer", node: layer });
    },
  }),
  meta: {
    docs: {
      description: "Require it.layer(...) to receive testMainLayer(...) directly.",
    },
    messages: {
      onlyTestMainLayer:
        "it.layer(...) must call testMainLayer(...) inline. Pass config, acubeSeed or session through its options instead of sharing, wrapping or composing a suite layer.",
    },
    schema: [],
    type: "problem",
  },
});

export default definePlugin({
  meta: { name: "test-layer-policy" },
  rules: { "only-test-main-layer": onlyTestMainLayer },
});
