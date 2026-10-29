import { definePlugin, defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";
import {
  isStandardLibrary,
  isUnresolved,
  libraryCheck,
  projectFor,
  typeAt,
} from "./type-information.ts";
import { isObject, isString } from "./predicates.ts";

const guardName = /^(?:is|has)[A-Z]/u;

const mayNameCheck = (name: string) =>
  guardName.test(name) || name === "isArray" || name === "parse" || name === "String";

const memberName = (node: ESTree.MemberExpression) => {
  if (!node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  if (node.property.type === "Literal" && isString(node.property.value)) {
    return node.property.value;
  }
  return undefined;
};

const mayReadCheck = (node: ESTree.Node | null | undefined, aliases: ReadonlySet<string>) => {
  if (node?.type === "Identifier") {
    return mayNameCheck(node.name) || aliases.has(node.name);
  }
  if (node?.type === "MemberExpression") {
    const name = memberName(node);
    return (
      name === undefined ||
      mayNameCheck(name) ||
      (node.object.type === "Identifier" && node.object.name === "String")
    );
  }
  return false;
};

const noUnknownNarrowing = defineRule({
  create: (context) => {
    const [option] = context.options;
    const helper =
      isObject(option) && "helper" in option && isString(option.helper)
        ? option.helper
        : "a helper that reads the message off a thrown value";
    const unresolved = (node: ESTree.Node) => {
      const project = projectFor(context.physicalFilename);
      return isUnresolved(project.checker, typeAt(project, context.physicalFilename, node));
    };
    const aliases = new Set<string>();
    const aliasSources: Array<{ readonly local: string; readonly source: ESTree.Node }> = [];
    const calls: ESTree.CallExpression[] = [];
    const resolveAliases = () => {
      const found = aliasSources.filter(
        ({ local, source }) => !aliases.has(local) && mayReadCheck(source, aliases),
      );
      for (const { local } of found) {
        aliases.add(local);
      }
      if (found.length > 0) {
        resolveAliases();
      }
    };

    const checkCall = (node: ESTree.CallExpression) => {
      const project = projectFor(context.physicalFilename);
      const check = libraryCheck(project, context.physicalFilename, node.callee);
      if (check === "JSON.parse") {
        context.report({ messageId: "jsonParse", node });
        return;
      }
      const [argument] = node.arguments;
      if (
        check !== null &&
        argument !== undefined &&
        argument.type !== "SpreadElement" &&
        unresolved(argument)
      ) {
        context.report({ data: { check }, messageId: "unknownNarrowing", node });
      }
    };

    return {
      BinaryExpression: (node: ESTree.BinaryExpression | ESTree.PrivateInExpression) => {
        if (node.operator === "instanceof") {
          const project = projectFor(context.physicalFilename);
          const symbol = project.checker.getSymbolAtPosition(
            context.physicalFilename,
            node.right.end - 1,
          );
          if (
            symbol?.name === "Error" &&
            symbol.declarations.some((declaration) => isStandardLibrary(declaration.path))
          ) {
            context.report({ data: { helper }, messageId: "instanceofError", node });
          }
        }
        if (
          node.operator === "in" &&
          node.left.type !== "PrivateIdentifier" &&
          unresolved(node.right)
        ) {
          context.report({ data: { check: "`in`" }, messageId: "unknownNarrowing", node });
        }
      },
      CallExpression: (node: ESTree.CallExpression) => {
        calls.push(node);
      },
      ImportSpecifier: (node: ESTree.ImportSpecifier) => {
        const imported =
          node.imported.type === "Identifier" ? node.imported.name : node.imported.value;
        if (mayNameCheck(imported)) {
          aliases.add(node.local.name);
        }
      },
      "Program:exit": () => {
        resolveAliases();
        for (const call of calls) {
          const named =
            call.callee.type === "Identifier" || call.callee.type === "MemberExpression";
          if (!named || mayReadCheck(call.callee, aliases)) {
            checkCall(call);
          }
        }
      },
      VariableDeclarator: (node: ESTree.VariableDeclarator) => {
        if (node.id.type === "Identifier" && node.init !== null) {
          aliasSources.push({ local: node.id.name, source: node.init });
        }
        if (node.id.type !== "ObjectPattern") {
          return;
        }
        for (const property of node.id.properties) {
          if (
            property.type === "Property" &&
            !property.computed &&
            property.key.type === "Identifier" &&
            mayNameCheck(property.key.name) &&
            property.value.type === "Identifier"
          ) {
            aliases.add(property.value.name);
          }
        }
      },
      TSTypePredicate: (node: ESTree.TSTypePredicate) => {
        if (node.parameterName.type !== "Identifier") {
          return;
        }
        const project = projectFor(context.physicalFilename);
        const symbol = project.checker.getSymbolAtPosition(
          context.physicalFilename,
          node.parameterName.end - 1,
        );
        if (
          isUnresolved(
            project.checker,
            symbol === undefined ? undefined : project.checker.getTypeOfSymbol(symbol),
          )
        ) {
          context.report({ messageId: "unprovedPredicate", node });
        }
      },
    };
  },
  meta: {
    docs: {
      description: "Require a schema contract before narrowing unresolved inputs.",
    },
    messages: {
      instanceofError:
        "`instanceof Error` reads a shape off a value nobody described. Carry the caught value as `cause` in a tagged error, or decode it once with {{helper}}.",
      jsonParse:
        "`JSON.parse` answers `any`. Decode the text with `Schema.fromJsonString(schema)` so the result carries a contract.",
      unknownNarrowing:
        "{{check}} narrows an `unknown` without establishing its contract. Decode the value once with `Schema.decodeUnknownEffect*` at the boundary it came from, then branch on the typed result.",
      unprovedPredicate:
        "A handwritten predicate over an unresolved input asserts a contract the compiler cannot prove. Derive the guard from Schema.is, or decode the input with Schema.decodeUnknownEffect*.",
    },
    schema: [
      {
        additionalProperties: false,
        properties: {
          helper: { type: "string" },
        },
        type: "object",
      },
    ],
    type: "problem",
  },
});

export default definePlugin({
  meta: { name: "narrowing-policy" },
  rules: { "no-unknown-narrowing": noUnknownNarrowing },
});
