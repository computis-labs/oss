export const publicPackages = ["effect-xml", "effect-md", "effect-pdf"] as const;

export const publicRoot = "oss";

export const publicFiles = [
  "packages/config/tsconfig/base.json",
  "packages/config/tsconfig/node.json",
  "packages/config/tsconfig/paths.json",
  "scripts/oss-check.ts",
  "scripts/oss-packages.ts",
  "scripts/oss-release.ts",
] as const;

export const privateFileNames = ["AGENTS.md"] as const;

export const publicRepository = "computis-labs/oss";

export const publicMirrorRef = "refs/oss/main";

export const importBranchPrefix = "oss/pull/";
