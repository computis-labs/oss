import { definePlugin, defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";
import { isString } from "./predicates.ts";

const noDatabaseServiceProvision = defineRule({
  create: (context) => ({
    CallExpression: (node: ESTree.CallExpression) => {
      const { callee } = node;

      if (callee.type !== "MemberExpression") {
        return;
      }

      const { object, property } = callee;
      if (
        object.type !== "Identifier" ||
        object.name !== "Effect" ||
        property.type !== "Identifier" ||
        property.name !== "provideService"
      ) {
        return;
      }

      const serviceTag = node.arguments.length === 2 ? node.arguments[0] : node.arguments[1];
      if (serviceTag?.type !== "Identifier" || serviceTag.name !== "DatabaseService") {
        return;
      }

      context.report({ messageId: "noDatabaseServiceProvision", node: callee });
    },
  }),
  meta: {
    docs: {
      description:
        "Disallow providing DatabaseService at production call sites; resolve it in a construction effect instead.",
    },
    messages: {
      noDatabaseServiceProvision:
        "Do not provide DatabaseService at a call site. Resolve it in a construction effect and keep the database client in the returned function.",
    },
    schema: [],
    type: "problem",
  },
});

const scopeAtBoundary = defineRule({
  create: (context) => {
    const scopes = new Set(["OrganizationScope"]);
    return {
      ImportDeclaration: (node: ESTree.ImportDeclaration) => {
        for (const specifier of node.specifiers) {
          if (
            specifier.type === "ImportSpecifier" &&
            specifier.imported.type === "Identifier" &&
            specifier.imported.name === "OrganizationScope"
          ) {
            scopes.add(specifier.local.name);
          }
        }
      },
      MemberExpression: (node: ESTree.MemberExpression) => {
        if (node.object.type !== "Identifier" || !scopes.has(node.object.name)) {
          return;
        }
        let name: string | null = null;
        if (node.property.type === "Identifier" && !node.computed) {
          ({ name } = node.property);
        } else if (node.property.type === "Literal" && isString(node.property.value)) {
          name = node.property.value;
        }
        if (name === "company" || name === "firm" || name === "companyOf") {
          context.report({ messageId: "scopeAtBoundary", node });
        }
      },
    };
  },
  meta: {
    docs: { description: "Keep tenant scope provision at approved access and job boundaries." },
    messages: {
      scopeAtBoundary:
        "Use the organization scope in context. Provide company or firm scope only at an approved boundary or an authorized cross-tenant operation.",
    },
    schema: [],
    type: "problem",
  },
});

const REPOSITORY_FILE = /(?:^|[/\\-])repository\.ts$/u;

const dbOnlyInRepository = defineRule({
  create: (context) => {
    if (REPOSITORY_FILE.test(context.filename)) {
      return {};
    }
    return {
      ImportSpecifier: (node: ESTree.ImportSpecifier) => {
        if (node.imported.type === "Identifier" && node.imported.name === "DatabaseService") {
          context.report({ messageId: "dbOnlyInRepository", node });
        }
      },
    };
  },
  meta: {
    docs: {
      description:
        "Keep DatabaseService, and with it queries and transactions, inside repository files.",
    },
    messages: {
      dbOnlyInRepository:
        "Only a repository.ts or <name>-repository.ts file may use DatabaseService. Call a repository method from here; a critical write opens its transaction inside that method.",
    },
    schema: [],
    type: "problem",
  },
});

const SQL_SERIALIZATION =
  /\bfor\s+(?:no\s+key\s+)?update\b|\bfor\s+(?:key\s+)?share\b|\bpg_(?:try_)?advisory_/iu;

const isDatabaseClient = (node: ESTree.Node) =>
  (node.type === "Identifier" && node.name === "db") ||
  (node.type === "MemberExpression" &&
    !node.computed &&
    node.property.type === "Identifier" &&
    node.property.name === "db");

const criticalWrites = defineRule({
  create: (context) => ({
    CallExpression: (node: ESTree.CallExpression) => {
      const { callee } = node;
      if (
        callee.type !== "MemberExpression" ||
        callee.computed ||
        callee.property.type !== "Identifier" ||
        callee.property.name !== "transaction" ||
        !isDatabaseClient(callee.object)
      ) {
        return;
      }
      context.report({
        data: { what: "a transaction" },
        messageId: "criticalWrites",
        node: callee.property,
      });
    },
    Property: (node: ESTree.Property) => {
      const { key, parent } = node;
      const isLockKey =
        (key.type === "Identifier" && !node.computed && key.name === "lock") ||
        (key.type === "Literal" && key.value === "lock");
      if (
        !isLockKey ||
        parent?.type !== "ObjectExpression" ||
        parent.parent?.type !== "CallExpression" ||
        parent.parent.callee.type !== "MemberExpression" ||
        !parent.parent.arguments.includes(parent)
      ) {
        return;
      }
      context.report({ data: { what: "a row lock" }, messageId: "criticalWrites", node: key });
    },
    TaggedTemplateExpression: (node: ESTree.TaggedTemplateExpression) => {
      if (
        node.tag.type !== "Identifier" ||
        node.tag.name !== "sql" ||
        !node.quasi.quasis.some((quasi) => SQL_SERIALIZATION.test(quasi.value.raw))
      ) {
        return;
      }
      context.report({ data: { what: "a lock" }, messageId: "criticalWrites", node });
    },
  }),
  meta: {
    docs: {
      description:
        "Allow a transaction or a lock only in a critical write whose line names the invariant it protects.",
    },
    messages: {
      criticalWrites:
        "This opens {{what}}. Only a critical write may (CODING_STANDARDS.md#critical-transactions): run the writes as plain statements in sequence, or disable database-policy/critical-writes on this line with the invariant it protects as the reason.",
    },
    schema: [],
    type: "problem",
  },
});

export default definePlugin({
  meta: { name: "database-policy" },
  rules: {
    "critical-writes": criticalWrites,
    "db-only-in-repository": dbOnlyInRepository,
    "no-database-service-provision": noDatabaseServiceProvision,
    "scope-at-boundary": scopeAtBoundary,
  },
});
