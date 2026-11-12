import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { processOwner } from "./processes.ts";
import { acquireOwnership } from "./ownership.ts";
import { SERVED_DOCS } from "./served-docs.mjs";

export const ROOT = resolve(import.meta.dirname, "..");
const REPO = dirname(ROOT);
const CACHE = join(REPO, ".work/tmp/builds");
const BUILD_ENV: Readonly<Record<BuildTarget, readonly string[]>> = { stats: ["STATS_DOMAIN"], observe: [], node: [] };
export type BuildTarget = "stats" | "observe" | "node";
export interface BuiltArtifact { readonly target: BuildTarget; readonly identity: string; readonly output: string; readonly generation: string; readonly outputHash: string; readonly typesHash: string | null }
const TARGETS = {
  stats: { config: "vite.config.ts", entries: ["src/cloudflare/index.ts", "src/client/index.tsx", "cloudflare.config.ts", "vite.config.ts", "scripts/served-docs.mjs"], output: ".cloudflare/output", publish: ".cloudflare/output" },
  observe: { config: "observe-worker/vite.config.ts", entries: ["src/observe/cloudflare/worker.ts", "observe-worker/cloudflare.config.ts", "observe-worker/vite.config.ts"], output: "observe-worker/.cloudflare/output", publish: "observe-worker/.cloudflare/output" },
  node: { config: "vite.node.config.ts", entries: ["src/node/main.ts", "vite.node.config.ts"], output: "../.work/tmp/node-bundle", publish: "../.work/tmp/node-bundle" }
} as const;

function files(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`build inputs and outputs cannot contain symlinks: ${path}`);
    return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
  }).sort();
}

export function buildInputs(target: BuildTarget): Map<string, Buffer> {
  const pending: string[] = TARGETS[target].entries.map(path => join(ROOT, path));
  if (target === "stats") pending.push(join(ROOT, "index.html"), ...files(join(ROOT, "public")), ...SERVED_DOCS.map(file => join(REPO, "docs", file)));
  const inputs = new Map<string, Buffer>();
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (inputs.has(path)) continue;
    if (lstatSync(path).isSymbolicLink()) throw new Error(`build source cannot be a symlink: ${path}`);
    const bytes = readFileSync(path);
    inputs.set(path, bytes);
    if (![".ts", ".tsx", ".mjs", ".css"].includes(extname(path))) continue;
    const imports = /(?:\bfrom\s*|\bimport\s*\(?\s*|@import\s*)["'](\.[^"']+)["']/gu;
    for (const match of bytes.toString("utf8").matchAll(imports)) {
      const base = resolve(dirname(path), match[1]!);
      const dependency = [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, join(base, "index.ts"), join(base, "index.tsx")].find(candidate => existsSync(candidate) && lstatSync(candidate).isFile());
      if (dependency === undefined) throw new Error(`cannot resolve build input ${match[1]} in ${path}`);
      if (!dependency.startsWith(`${REPO}/`)) throw new Error(`build input leaves the repository: ${dependency}`);
      pending.push(dependency);
    }
  }
  for (const path of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".node-version", "cloudflare/package.json", "cloudflare/tsconfig.json", "cloudflare/scripts/ensure-build.ts", "cloudflare/scripts/ownership.ts", "cloudflare/scripts/processes.ts"]) inputs.set(join(REPO, path), readFileSync(join(REPO, path)));
  return inputs;
}

function identity(target: BuildTarget, inputs: ReadonlyMap<string, Buffer>, mode: string): string {
  const hash = createHash("sha256").update(JSON.stringify({ schema: 1, target, mode, node: process.version, platform: process.platform, arch: process.arch, env: Object.fromEntries(BUILD_ENV[target].map(name => [name, process.env[name] ?? null])), command: ["vite", "build", "--config", TARGETS[target].config] }));
  hash.update(readFileSync(join(REPO, "node_modules/.pnpm/lock.yaml")));
  for (const [path, bytes] of [...inputs].sort(([a], [b]) => a.localeCompare(b))) hash.update(relative(REPO, path)).update("\0").update(bytes).update("\0");
  return hash.digest("hex");
}

function outputHash(output: string): string {
  const hash = createHash("sha256");
  const paths = files(output);
  if (paths.length === 0) throw new Error(`empty build output: ${output}`);
  for (const path of paths) hash.update(relative(output, path)).update("\0").update(readFileSync(path)).update("\0");
  return hash.digest("hex");
}

function publish(link: string, destination: string): void {
  mkdirSync(dirname(link), { recursive: true });
  if (existsSync(link) && !lstatSync(link).isSymbolicLink()) renameSync(link, join(CACHE, `previous-${randomUUID()}`));
  const pending = `${link}.${randomUUID()}`;
  try { symlinkSync(destination, pending, "dir"); renameSync(pending, link); }
  finally { rmSync(pending, { force: true }); }
}

function typesPath(generation: string, target: BuildTarget): string | null {
  return target === "node" ? null : join(generation, "cloudflare", target === "observe" ? "observe-worker/.cloudflare/types" : ".cloudflare/types");
}

function publishTypes(generation: string, target: BuildTarget): void {
  const types = typesPath(generation, target);
  if (types !== null) publish(join(ROOT, target === "observe" ? "observe-worker/.cloudflare/types" : ".cloudflare/types"), types);
}

export async function ensureBuild(target: BuildTarget, { clean = false, mode = "production", signal = new AbortController().signal }: { readonly clean?: boolean; readonly mode?: string; readonly signal?: AbortSignal } = {}): Promise<BuiltArtifact> {
  const release = await acquireOwnership(join(CACHE, `${target}.sqlite`), signal);
  const owner = processOwner(`build-${target}`);
  const cancel = (): void => { void owner.stop(); };
  signal.addEventListener("abort", cancel, { once: true });
  const recordPath = join(CACHE, `${target}.json`);
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      signal.throwIfAborted();
      const inputs = buildInputs(target);
      const key = identity(target, inputs, mode);
      if (!clean && existsSync(recordPath)) {
        const cached = JSON.parse(readFileSync(recordPath, "utf8")) as BuiltArtifact;
        if (cached.identity === key && existsSync(cached.output)) {
          try {
            const types = typesPath(cached.generation, target);
            if (outputHash(cached.output) === cached.outputHash && (types === null || outputHash(types) === cached.typesHash)) {
              publish(resolve(ROOT, TARGETS[target].publish), cached.output);
              publishTypes(cached.generation, target);
              console.error(`build: ${target} hit ${key.slice(0, 12)}`);
              return cached;
            }
          } catch { }
        }
      }
      const generation = mkdtempSync(join(CACHE, `${target}-`));
      let retained = false;
      try {
        const workspace = join(generation, "cloudflare");
        for (const [path, bytes] of inputs) {
          const copy = join(generation, relative(REPO, path));
          mkdirSync(dirname(copy), { recursive: true });
          writeFileSync(copy, bytes);
        }
        symlinkSync(join(ROOT, "node_modules"), join(workspace, "node_modules"), "dir");
        const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "SYSTEMROOT", ...BUILD_ENV[target]].flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
        console.error(`build: ${target} miss ${key.slice(0, 12)} (${clean ? "clean requested" : "inputs, toolchain, mode, environment, or output changed"})`);
        await owner.run(target, process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "build", "--config", TARGETS[target].config, "--mode", mode], { cwd: workspace, env });
        signal.throwIfAborted();
        if (identity(target, buildInputs(target), mode) !== key) { console.error(`build: ${target} superseded; retrying current inputs`); continue; }
        const output = resolve(workspace, TARGETS[target].output);
        const types = typesPath(generation, target);
        const result = { target, identity: key, output, generation, outputHash: outputHash(output), typesHash: types === null ? null : outputHash(types) };
        const pending = `${recordPath}.${randomUUID()}`;
        writeFileSync(pending, JSON.stringify(result));
        publish(resolve(ROOT, TARGETS[target].publish), output);
        publishTypes(generation, target);
        renameSync(pending, recordPath);
        retained = true;
        return result;
      } finally { if (!retained) rmSync(generation, { recursive: true, force: true }); }
    }
    throw new Error(`${target} inputs changed during five consecutive builds; retry when edits settle`);
  } finally { signal.removeEventListener("abort", cancel); await owner.close(); release(); }
}

export async function ensureBuilds(targets: readonly BuildTarget[], options: Parameters<typeof ensureBuild>[1] = {}): Promise<BuiltArtifact[]> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const artifacts = await Promise.all([...new Set(targets)].map(target => ensureBuild(target, options)));
    if (artifacts.every(artifact => identity(artifact.target, buildInputs(artifact.target), options?.mode ?? "production") === artifact.identity)) return artifacts;
    console.error("build: source changed while preparing the group; retrying matching outputs");
  }
  throw new Error("build inputs kept changing while preparing matching outputs");
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { target: { type: "string", multiple: true }, clean: { type: "boolean" }, mode: { type: "string", default: "production" } } });
  const targets = values.target ?? ["stats", "observe"];
  for (const target of targets) if (!(target in TARGETS)) throw new Error(`unknown build target ${target}`);
  try { await ensureBuilds(targets as BuildTarget[], { clean: values.clean ?? false, mode: values.mode }); }
  catch (error) { console.error(error); process.exitCode ||= 1; }
}
