import { existsSync, readdirSync } from "node:fs";
import { join, matchesGlob, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "..");
export const NODE_DIRECTORIES = ["binary", "ingest", "deployments", "cost", "cli", "scripts", "observe", "node", "producer"];
export interface TestFile {
  readonly file: string;
  readonly owner: string;
  readonly runner: "node" | "vitest" | "playwright";
  readonly prerequisites: readonly string[];
  readonly optIn: boolean;
}
const SPECIAL: Readonly<Record<string, readonly [string, readonly string[], boolean?]>> = {
  "test/node/parity.test.ts": ["parity", ["stats", "observe"]],
  "test/node/http-parity.test.ts": ["parity", ["stats", "observe"]],
  "test/cli/check.test.ts": ["parity", ["stats", "observe"]],
  "test/observe/budget.test.ts": ["observe-runtime", ["observe"]],
  "test/scripts/node-bundle.test.ts": ["node-package", ["node-bundle-in-test"]],
  "test/scripts/build-preparation.test.ts": ["build-orchestration", ["isolated-builds-in-test"]],
  "test/scripts/development.test.ts": ["dev-orchestration", ["isolated-builds-in-test", "chromium"]],
  "test/external/services.test.ts": ["services-external", ["TANSU_DIR", "NICEFORGE_DIR"], true],
  "test/producer/checkout.test.ts": ["producer-external", ["stats", "observe", "NANOSHOP_DIR"], true]
};

export function inventory(root = ROOT): TestFile[] {
  for (const path of Object.keys(SPECIAL)) if (!existsSync(join(root, path))) throw new Error(`declared test does not exist: ${path}`);
  return readdirSync(join(root, "test"), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /(?:\.test\.(?:ts|mjs)|\.spec\.ts|\.node\.ts)$/u.test(entry.name))
    .map(entry => {
      const file = join(entry.parentPath, entry.name).slice(root.length + 1).replaceAll("\\", "/");
      const directory = file.split("/")[1]!;
      let owner: string;
      let runner: TestFile["runner"] = "node";
      let prerequisites: readonly string[] = [];
      let optIn = false;
      const special = SPECIAL[file];
      if (special !== undefined) [owner, prerequisites, optIn = false] = special;
      else if (directory === "ui") { owner = "browser"; runner = "playwright"; prerequisites = ["stats", ...(entry.name === "local-stack.spec.ts" ? ["observe"] : [])]; optIn = true; }
      else if (directory === "rivet-eval") { owner = "rivet-eval"; optIn = true; }
      else if (!file.slice(5).includes("/")) { owner = "worker"; runner = "vitest"; prerequisites = ["worker-source"]; }
      else if (NODE_DIRECTORIES.includes(directory)) owner = directory;
      else if (["local", "observe-e2e", "profile"].includes(directory)) { owner = directory; prerequisites = ["stats", "observe"]; }
      else if (["agent-e2e", "node-e2e"].includes(directory)) { owner = directory; prerequisites = ["stats", directory === "node-e2e" ? "node" : "observe", "agent-debug"]; optIn = true; }
      else throw new Error(`unowned test: ${file}; declare its execution route in scripts/test-suites.mjs`);
      return { file, owner, runner, prerequisites, optIn };
    }).sort((a, b) => a.file.localeCompare(b.file));
}

export function selectTests(all: readonly TestFile[], { files = [], suites = [] }: { readonly files?: readonly string[] | undefined; readonly suites?: readonly string[] | undefined } = {}): TestFile[] {
  const matches = (entry: TestFile, selector: string) => entry.file === selector || entry.file.startsWith(`${selector.replace(/\/$/u, "")}/`) || matchesGlob(entry.file, selector);
  for (const file of files) if (!all.some(entry => matches(entry, file))) throw new Error(`unmatched test selector: ${file}`);
  for (const suite of suites) if (!all.some(entry => entry.owner === suite)) throw new Error(`unknown suite: ${suite}`);
  return all.filter(entry => (files.length === 0 || files.some(file => matches(entry, file))) && (suites.length === 0 || suites.includes(entry.owner)) && (files.length > 0 || suites.length > 0 || !entry.optIn));
}
