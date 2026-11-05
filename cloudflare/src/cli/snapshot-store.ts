import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transportError } from "./exit.ts";
import { SNAPSHOT_MAX_BYTES } from "./snapshot-format.ts";

export const SNAPSHOT_DIRECTORY_MAX_BYTES = 200 * 1024 * 1024;

const CLI_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(CLI_DIRECTORY, "..", "..", "..");
export const DEFAULT_SNAPSHOT_DIRECTORY = join(REPOSITORY_ROOT, ".work", "statsctl", "snapshots");

export interface Written {
  readonly path: string;
  readonly bytes: number;
  readonly pruned: number;
}

export function cliRevision(): string {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: CLI_DIRECTORY, stdio: ["ignore", "pipe", "ignore"], timeout: 5000, encoding: "utf8" }).trim();
    return /^[0-9a-f]{40}$/u.test(sha) ? sha : "unknown";
  } catch {
    return "unknown";
  }
}

export function invocationDirectory(): string {
  return process.env["INIT_CWD"] ?? process.cwd();
}

export function snapshotPath(out: string): string {
  return out.includes("/") || out.includes("\\") ? resolve(invocationDirectory(), out) : join(DEFAULT_SNAPSHOT_DIRECTORY, out);
}

export function pruneDirectory(directory: string, keep: string, limit: number): number {
  const entries = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
    .map(entry => {
      const { size, mtimeMs } = statSync(join(directory, entry.name));
      return { path: join(directory, entry.name), size, mtimeMs };
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  let removed = 0;
  for (const entry of entries) {
    if (total <= limit) break;
    if (entry.path === keep) continue;
    rmSync(entry.path);
    total -= entry.size;
    removed += 1;
  }
  return removed;
}

export function writeSnapshotFile(out: string, text: string, limits: { readonly snapshotBytes: number; readonly directoryBytes: number } = { snapshotBytes: SNAPSHOT_MAX_BYTES, directoryBytes: SNAPSHOT_DIRECTORY_MAX_BYTES }): Written {
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > limits.snapshotBytes) throw transportError("snapshot_too_large", `the snapshot is ${bytes} bytes; the cap is ${limits.snapshotBytes}`);
  const path = snapshotPath(out);
  const directory = dirname(path);
  const scratch = join(directory, `.${basename(path)}.${process.pid}.tmp`);
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(scratch, text, { mode: 0o600 });
    renameSync(scratch, path);
    return { path, bytes, pruned: directory === DEFAULT_SNAPSHOT_DIRECTORY ? pruneDirectory(directory, path, limits.directoryBytes) : 0 };
  } catch (error) {
    rmSync(scratch, { force: true });
    throw transportError("snapshot_unwritable", `cannot write ${path}: ${error instanceof Error ? error.message : "failed"}`);
  }
}

export function readSnapshotFile(file: string): string {
  const path = resolve(invocationDirectory(), file);
  try {
    const size = statSync(path).size;
    if (size > SNAPSHOT_MAX_BYTES) throw transportError("snapshot_too_large", `${path} is ${size} bytes; the cap is ${SNAPSHOT_MAX_BYTES}`);
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && error.name === "CommandError") throw error;
    throw transportError("snapshot_unreadable", `cannot read ${path}: ${error instanceof Error ? error.message : "failed"}`);
  }
}
