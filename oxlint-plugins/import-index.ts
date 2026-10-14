import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import type { Dirent } from "node:fs";

import { publicPackages } from "../scripts/oss-packages.ts";

const IGNORED_DIRECTORIES = new Set([
  ".astro",
  ".claude",
  ".codex",
  ".git",
  ".next",
  ".pi",
  ".svelte-kit",
  ".turbo",
  ".vercel",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "repos",
  "target",
]);

const SCANNED_EXTENSIONS = new Set([
  ".astro",
  ".cts",
  ".js",
  ".jsx",
  ".mts",
  ".svelte",
  ".ts",
  ".tsx",
]);

// Matches the specifier list of `import { A, type B as C } from "…"` and of
// `export { A } from "…"`, which are the only two ways another file can claim a name.
const NAMED_CLAUSE = /\b(?:import|export)\b[^;{]*\{(?<names>[^}]*)\}\s*from\s*["'][^"']+["']/gu;
const DEFAULT_CLAUSE = /\bimport\s+(?:type\s+)?(?<name>[A-Za-z_$][\w$]*)\s*(?:,|from\b)/gu;
const SPECIFIER_NAME = /^(?:type\s+)?(?<name>[A-Za-z_$][\w$]*)/u;
const WILDCARD_CLAUSE =
  /\b(?:import|export)\s+(?:type\s+)?\*(?:\s+as\s+[A-Za-z_$][\w$]*)?\s*from\s*["'](?<specifier>[^"']+)["']/gu;

interface ModuleIndex {
  readonly names: Map<string, Set<string>>;
  readonly wildcards: Map<string, Set<string>>;
}

const indexes = new Map<string, ModuleIndex>();

const collectFiles = (directory: string, files: string[]) => {
  let entries: Dirent[] = [];

  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        collectFiles(entryPath, files);
      }
      continue;
    }
    if (entry.isFile() && SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(entryPath);
    }
  }

  return files;
};

const importedNames = (source: string) => {
  const names = new Set<string>();

  for (const match of source.matchAll(NAMED_CLAUSE)) {
    for (const specifier of (match.groups?.names ?? "").split(",")) {
      const name = SPECIFIER_NAME.exec(specifier.trim())?.groups?.name;

      if (name !== undefined) {
        names.add(name);
      }
    }
  }
  for (const match of source.matchAll(DEFAULT_CLAUSE)) {
    const name = match.groups?.name;

    if (name !== undefined) {
      names.add(name);
    }
  }

  return names;
};

const withoutExtension = (file: string) => file.slice(0, -path.extname(file).length || undefined);

/**
 * The segments after an alias or a package name: `#/x`, `#shared/x`, `@/x` and
 * `@computis/shared/x` all answer `x`, which is the tail the declaring file's path ends with.
 */
const aliasTail = (specifier: string) => {
  const [head = "", ...rest] = specifier.split("/");

  if (head.startsWith("@") && head.length > 1) {
    return rest.slice(1).join("/");
  }

  return head.startsWith("#") || head.startsWith("@") ? rest.join("/") : specifier;
};

/**
 * A module key that both sides can agree on without running module resolution: relative
 * specifiers resolve to an absolute path, and every other form (package, aliased subpath)
 * keeps its trailing segments, which are then matched against the declaring file's tail.
 */
const moduleKey = (specifier: string, importer: string) =>
  specifier.startsWith(".")
    ? `path:${withoutExtension(path.resolve(path.dirname(importer), specifier))}`
    : `tail:${withoutExtension(aliasTail(specifier))}`;

const buildIndex = (root: string): ModuleIndex => {
  const names = new Map<string, Set<string>>();
  const wildcards = new Map<string, Set<string>>();

  for (const file of collectFiles(root, [])) {
    let source = "";

    try {
      source = readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    for (const name of importedNames(source)) {
      const importers = names.get(name) ?? new Set<string>();

      importers.add(file);
      names.set(name, importers);
    }
    for (const match of source.matchAll(WILDCARD_CLAUSE)) {
      const specifier = match.groups?.specifier;

      if (specifier === undefined) {
        continue;
      }

      const key = moduleKey(specifier, file);
      const importers = wildcards.get(key) ?? new Set<string>();

      importers.add(file);
      wildcards.set(key, importers);
    }
  }

  return { names, wildcards };
};

const indexFor = (root: string) => {
  const cached = indexes.get(root);

  if (cached !== undefined) {
    return cached;
  }

  const index = buildIndex(root);

  indexes.set(root, index);

  return index;
};

/**
 * True when a file other than `filename` imports or re-exports `name`. Adding `export`
 * to a declaration therefore never silences a rule on its own: a second file must claim
 * the name for the declaration to count as shared.
 */
export const isImportedElsewhere = (name: string, filename: string) => {
  const root = process.cwd();
  const index = indexFor(root);
  const self = path.resolve(filename);
  const publicRoots = publicPackages.map((pkg) => path.join(root, "packages", pkg) + path.sep);
  const isPublic = (file: string) => publicRoots.some((publicRoot) => file.startsWith(publicRoot));
  const claimedByOther = (importers: ReadonlySet<string> | undefined) => {
    for (const importer of importers ?? []) {
      const resolved = path.resolve(importer);

      if (resolved !== self && (!isPublic(self) || isPublic(resolved))) {
        return true;
      }
    }

    return false;
  };

  if (claimedByOther(index.names.get(name))) {
    return true;
  }

  const selfModule = withoutExtension(self);
  const selfIndexModule = path.join(selfModule, "index");

  for (const [key, importers] of index.wildcards) {
    const target = key.slice(key.indexOf(":") + 1);
    const matches = key.startsWith("path:")
      ? target === selfModule || target === selfIndexModule
      : selfModule.endsWith(`${path.sep}${target.split("/").join(path.sep)}`);

    if (matches && claimedByOther(importers)) {
      return true;
    }
  }

  return false;
};
