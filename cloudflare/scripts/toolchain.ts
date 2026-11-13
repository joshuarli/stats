import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function nodePin(root = resolve(import.meta.dirname, "..")): string {
  const pin = readFileSync(resolve(root, "../.node-version"), "utf8").trim();
  return `v${pin}`;
}

export function requirePinnedNode(): void {
  const pin = nodePin();
  const matches = /^v\d+\.\d+$/.test(pin) ? process.version.startsWith(`${pin}.`) : process.version === pin;
  if (!matches) throw new Error(`use Node ${pin} from .node-version; running ${process.version} at ${process.execPath}`);
}
