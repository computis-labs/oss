import path from "node:path";
import { definePlugin, defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";
import { projectFor } from "./type-information.ts";
import { isString } from "./predicates.ts";

const isTestSource = (filename: string) =>
  /(?:^|\/)(?:tests?|__tests__|e2e)(?:\/|$)|\.(?:test|spec|fixtures|stories)(?:\.[cm]?[jt]sx?)?$|(?:^|\/)test-(?:support|helpers|harness)(?:\.[cm]?[jt]sx?)?$/u.test(
    filename,
  );

const noTestImports = defineRule({
  create: (context) => {
    const skip = isTestSource(context.physicalFilename);
    const check = (source: ESTree.Node, specifier: string) => {
      if (skip) {
        return;
      }
      let forbidden = isTestSource(path.posix.normalize(specifier));
      if (!forbidden) {
        const project = projectFor(context.physicalFilename);
        const symbol = project.checker.getSymbolAtPosition(
          context.physicalFilename,
          source.end - 2,
        );
        forbidden =
          symbol?.declarations.some(
            (declaration) =>
              !declaration.path.includes("/node_modules/") && isTestSource(declaration.path),
          ) ?? false;
      }
      if (forbidden) {
        context.report({ messageId: "testImport", node: source });
      }
    };
    return {
      CallExpression: (node: ESTree.CallExpression) => {
        const [source] = node.arguments;
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          source?.type === "Literal" &&
          isString(source.value)
        ) {
          check(source, source.value);
        }
      },
      ExportAllDeclaration: (node: ESTree.ExportAllDeclaration) => {
        check(node.source, node.source.value);
      },
      ExportNamedDeclaration: (node: ESTree.ExportNamedDeclaration) => {
        if (node.source !== null) {
          check(node.source, node.source.value);
        }
      },
      ImportDeclaration: (node: ESTree.ImportDeclaration) => {
        check(node.source, node.source.value);
      },
      ImportExpression: (node: ESTree.ImportExpression) => {
        if (node.source.type === "Literal" && isString(node.source.value)) {
          check(node.source, node.source.value);
        }
      },
    };
  },
  meta: {
    docs: { description: "Keep test-only modules outside the production import graph." },
    messages: {
      testImport:
        "Production code must not import test support. Move the production contract to its owning module.",
    },
    schema: [],
    type: "problem",
  },
});

export default definePlugin({
  meta: { name: "test-boundary" },
  rules: { "no-test-imports": noTestImports },
});
