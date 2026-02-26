import { createHash } from "node:crypto";

// Patterns to replace with ? placeholder
const NORMALIZATIONS: [RegExp, string][] = [
  // Single-quoted strings (including escaped quotes)
  [/'(?:[^'\\]|\\.)*'/g, "?"],
  // Double-quoted strings
  [/"(?:[^"\\]|\\.)*"/g, "?"],
  // Hex literals
  [/\b0x[0-9a-fA-F]+\b/g, "?"],
  // Floats (must come before integers)
  [/\b\d+\.\d+\b/g, "?"],
  // Integers
  [/\b\d+\b/g, "?"],
  // Booleans
  [/\b(?:TRUE|FALSE)\b/gi, "?"],
  // NULL
  [/\bNULL\b/gi, "?"],
  // Collapse multiple ? in IN clauses
  [/\(\s*\?(?:\s*,\s*\?)*\s*\)/g, "(?)"],
  // Collapse whitespace
  [/\s+/g, " "],
];

export function normalize(sql: string): string {
  let result = sql;
  for (const [pattern, replacement] of NORMALIZATIONS) {
    result = result.replace(pattern, replacement);
  }
  return result.trim();
}

export function fingerprint(sql: string): string {
  const normalized = normalize(sql);
  return createHash("md5").update(normalized).digest("hex").slice(0, 12);
}
