import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function nodePin(root = resolve(import.meta.dirname, "..")): string {
  return `v${readFileSync(resolve(root, "../.node-version"), "utf8").trim()}`;
}

export function requirePinnedNode(): void {
  const required = nodePin();
  if (process.version !== required) throw new Error(`use Node ${required} from .node-version; running ${process.version} at ${process.execPath}`);
}
