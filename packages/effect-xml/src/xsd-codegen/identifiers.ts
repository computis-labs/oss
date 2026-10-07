import { HELPERS } from "./simple-type/emit.ts";

const RESERVED_WORDS = [
  "arguments",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield",
];

export const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

export const pascal = (name: string) => `${name.charAt(0).toUpperCase()}${name.slice(1)}`;

export const makeAllocator = () => {
  const used = new Set<string>([...RESERVED_WORDS, ...HELPERS, "Schema", "element", "root"]);
  return (preferred: string) => {
    const sanitized = preferred.replaceAll(/[^A-Za-z0-9_$]/gu, "_");
    const base = /^[0-9]/u.test(sanitized) ? `_${sanitized}` : sanitized;
    const candidate = used.has(base)
      ? (Array.from({ length: used.size }, (_, index) => `${base}${String(index + 2)}`).find(
          (suffixed) => !used.has(suffixed),
        ) ?? base)
      : base;
    used.add(candidate);
    return candidate;
  };
};
