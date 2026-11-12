import { copyFileSync, cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BuiltArtifact } from "./ensure-build.ts";

export function stageNode(artifacts: readonly BuiltArtifact[], directory: string): string {
  const node = artifacts.find(artifact => artifact.target === "node");
  const stats = artifacts.find(artifact => artifact.target === "stats");
  if (node === undefined || stats === undefined) throw new Error("staging a Node server requires the node and stats artifacts");
  const root = join(directory, "cloudflare");
  mkdirSync(join(root, "src/node"), { recursive: true });
  const entry = join(root, "src/node/main.mjs");
  copyFileSync(join(node.output, "main.mjs"), entry);
  cpSync(join(stats.output, "v0/workers/default/assets"), join(root, ".cloudflare/output/v0/workers/default/assets"), { recursive: true });
  return entry;
}
