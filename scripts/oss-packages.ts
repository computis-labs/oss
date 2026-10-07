export const publicPackages = ["effect-xml", "effect-md"] as const;

export const publicRoot = "oss";

export const publicFiles = [
  "packages/config/tsconfig/base.json",
  "packages/config/tsconfig/node.json",
  "packages/config/tsconfig/paths.json",
  "scripts/oss-check.ts",
  "scripts/oss-packages.ts",
] as const;

export const privateFileNames = ["AGENTS.md"] as const;

export const publicRepository = "computis-labs/oss";
