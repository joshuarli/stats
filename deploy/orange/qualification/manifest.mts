import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
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
function walkTree(directory: string, prefix: string, entries: Entry[], skip: readonly string[] = []) {
  const names = readdirSync(directory).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const name of names) {
    const path = prefix + name;
    if (skip.includes(path)) continue;
    const full = join(directory, name);
    const info = lstatSync(full);
    if (info.isDirectory()) { entries.push({ path, type: "directory" }); walkTree(full, `${path}/`, entries); }
    else if (info.isFile()) entries.push(fileEntry(path, full));
    else if (info.isSymbolicLink()) entries.push({ path, type: "symlink", target: readlinkSync(full) });
    else throw new Error(`unsupported file type: ${path}`);
  }
}

function fileEntry(path: string, full: string): Entry {
  const info = statSync(full);
  return { path, type: "file", sha256: `sha256:${createHash("sha256").update(readFileSync(full)).digest("hex")}`, size: info.size, executable: (info.mode & 0o111) !== 0 };
}

const sortEntries = (entries: Entry[]) => entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));

export function treeManifest(root: string): { schema: string; excluded: string[]; entries: Entry[] } {
  const entries: Entry[] = [];
  walkTree(root, "", entries, ["release.json"]);
  return { schema: "openorange-runtime-manifest/1", excluded: ["release.json"], entries: sortEntries(entries) };
}

/** The parts of a Stats app release: both Worker outputs, their descriptors and the infrastructure collector. */
export const APP_PARTS = ["collector", "observe", "observe.jsonc", "stats", "stats.jsonc"] as const;

/** The `stats-app-manifest/1` digest of an app release directory, matching Stuff's oomanifest.app_digest. */
export function appDigest(root: string): string {
  const names = readdirSync(root).filter(name => name !== "release.json").sort();
  if (names.join("\n") !== [...APP_PARTS].sort().join("\n")) throw new Error(`${root} must hold exactly ${APP_PARTS.join(", ")}`);
  const entries: Entry[] = [];
  for (const name of APP_PARTS) {
    const source = realpathSync(join(root, name));
    if (statSync(source).isDirectory()) { entries.push({ path: name, type: "directory" }); walkTree(source, `${name}/`, entries); }
    else entries.push(fileEntry(name, source));
  }
  return `sha256:${manifestDigest({ schema: "stats-app-manifest/1", entries: sortEntries(entries) })}`;
}

export const appReleaseId = (digest: string) => `app-${digest.replace(/^sha256:/, "").slice(0, 12)}`;
