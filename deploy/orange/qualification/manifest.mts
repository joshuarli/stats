import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

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

type Entry = { path: string; type: "directory" } | { path: string; type: "file"; sha256: string; size: number; executable: boolean } | { path: string; type: "symlink"; target: string };

/** The `openorange-runtime-manifest/1` content manifest of an extracted runtime, matching Stuff's deploy/openorange/lib/oomanifest.py. */
export function treeManifest(root: string): { schema: string; excluded: string[]; entries: Entry[] } {
  const entries: Entry[] = [];
  const walk = (directory: string, prefix: string) => {
    const names = readdirSync(directory).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    for (const name of names) {
      const path = prefix + name;
      if (path === "release.json") continue;
      const full = join(directory, name);
      const info = lstatSync(full);
      if (info.isDirectory()) { entries.push({ path, type: "directory" }); walk(full, `${path}/`); }
      else if (info.isFile()) entries.push({ path, type: "file", sha256: `sha256:${createHash("sha256").update(readFileSync(full)).digest("hex")}`, size: info.size, executable: (info.mode & 0o111) !== 0 });
      else if (info.isSymbolicLink()) entries.push({ path, type: "symlink", target: readlinkSync(full) });
      else throw new Error(`unsupported file type: ${path}`);
    }
  };
  walk(root, "");
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return { schema: "openorange-runtime-manifest/1", excluded: ["release.json"], entries };
}
