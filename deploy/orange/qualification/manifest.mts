import { createHash } from "node:crypto";

function compareKeys(left: string, right: string): number {
  const a = Array.from(left, character => character.codePointAt(0)!);
  const b = Array.from(right, character => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index++) if (a[index] !== b[index]) return a[index]! - b[index]!;
  return a.length - b.length;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => compareKeys(a, b)).map(([key, entry]) => `${canonicalJson(key)}:${canonicalJson(entry)}`).join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("manifest contains a non-JSON value");
  return encoded.replace(/[\u007f-\u{10ffff}]/gu, character => Array.from({ length: character.length }, (_, index) => `\\u${character.charCodeAt(index).toString(16).padStart(4, "0")}`).join(""));
}

export function manifestDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
