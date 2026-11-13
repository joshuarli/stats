#!/usr/bin/env node
// Thin dispatcher for the Rivet 3 / OpenOrange evaluation. Forwards to existing
// helpers and the pinned evaluator closure; campaign slices add commands as they land.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const REPO = resolve(import.meta.dirname, "..");
const EVAL = join(REPO, "experiments/rivet");
const RUNS = join(REPO, ".work/rivet-eval");
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
const requiredNode = `v${readFileSync(join(REPO, ".node-version"), "utf8").trim()}`;
const SUITES = { report: "R7" };

async function native(report, values) {
  if (values.candidate !== undefined) return { result: "blocked", reason: "native takes no candidate selector" };
  if (!existsSync(join(EVAL, "native/probe.mts"))) return { result: "blocked", reason: "native probe missing" };
  const done = spawnSync(process.execPath, [join(EVAL, "native/probe.mts"), report.run.id], { encoding: "utf8", env: process.env, maxBuffer: 64 * 1024 * 1024 });
  process.stderr.write(done.stderr ?? "");
  const text = (done.stdout ?? "").trim();
  const detail = parseTail(text);
  const result = detail?.result ?? (done.status === 0 ? "pass" : "fail");
  const reason = detail?.reason ?? (done.status === 0 ? null : `native probe failed (exit ${done.status}); see stderr above`);
  const evidenceDir = join(RUNS, report.run.id);
  mkdirSync(evidenceDir, { recursive: true });
  const path = join(evidenceDir, "native.json");
  writeFileSync(path, `${text || JSON.stringify({ result, reason })}\n`);
  return { result, reason, evidence: { path }, native: detail ?? { rawStdout: text } };
}

function base(command, runId) {
  return { schema: "rivet-eval/1", command, result: "pass", reason: null, revision: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain") !== "", hashes: { lockfile: sha256(join(REPO, "pnpm-lock.yaml")), fixtures: sha256(join(REPO, "fixtures/v2/manifest.json")), evaluatorManifest: sha256(join(EVAL, "package.json")) }, run: { id: runId, started: new Date().toISOString() }, platform: { os: process.platform, arch: process.arch, node: process.version, requiredNode, pnpm: execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(), sqlite: process.versions.sqlite }, evidence: {} };
}

function emit(report, started) {
  report.run.finished = new Date().toISOString();
  report.run.durationMs = Date.now() - started;
  const output = JSON.stringify(report, null, 2);
  if (report.evidence.path) writeFileSync(report.evidence.path, output + "\n");
  console.log(output);
  process.exitCode = report.result === "pass" ? 0 : report.result === "fail" ? 1 : 2;
}

function runDir(command, id) {
  const dir = join(RUNS, id);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${command}.json`);
}

function integrity() {
  const files = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "cloudflare/package.json"];
  return Object.fromEntries(files.map(file => [file, sha256(join(REPO, file))]));
}

function bootstrap(report, args) {
  if (process.version !== requiredNode) return { result: "blocked", reason: `use Node ${requiredNode}; running ${process.version}` };
  const before = integrity();
  const locked = existsSync(join(EVAL, "pnpm-lock.yaml"));
  const install = ["--dir", EVAL, "--ignore-workspace", "install", ...(locked ? ["--frozen-lockfile"] : []),
    "--allow-build", "esbuild", "--allow-build", "workerd",
    "--allow-build", "!@google/genai", "--allow-build", "!better-sqlite3", "--allow-build", "!cbor-extract", "--allow-build", "!protobufjs"];
  const done = spawnSync("pnpm", install, { encoding: "utf8", env: process.env });
  process.stderr.write(done.stdout ?? "");
  process.stderr.write(done.stderr ?? "");
  if (done.status !== 0) return { result: "blocked", reason: `bootstrap failed under install policy (exit ${done.status}); see stderr above` };
  const after = integrity();
  const changed = Object.keys(before).filter(file => before[file] !== after[file]);
  if (changed.length > 0) return { result: "fail", reason: `application manifests/lockfile changed during candidate bootstrap: ${changed.join(", ")}` };
  const installed = {};
  for (const name of ["open-orange", "rivetkit", "@rivetkit/engine-cli", "@rivet-dev/services", "wrangler"]) installed[name] = packageVersion(name);
  const binaries = {};
  const platformPkg = process.platform === "darwin" ? `@rivetkit/engine-cli-darwin-${process.arch}` : null;
  for (const [name, candidate] of [["rivet-engine", platformPkg === null ? null : join(packageDir(platformPkg) ?? "", "rivet-engine")], ["services", join(EVAL, "node_modules/.bin/services")]]) {
    if (candidate !== null && candidate !== "" && existsSync(candidate)) {
      const target = lstatSync(candidate).isSymbolicLink() ? realpathSync(candidate) : candidate;
      binaries[name] = { path: relativeTo(target), sha256: sha256(target), bytes: statSync(target).size };
      try { binaries[name].version = execFileSync(target, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim(); } catch (error) { binaries[name].version = null; binaries[name].versionError = String(error?.message ?? error).split("\n")[0]; }
    } else binaries[name] = null;
  }
  return { result: "pass", reason: null, evidence: { path: runDir("bootstrap", report.run.id) }, bootstrap: { locked, before, after, installed, binaries, frozen: locked } };
}
const relativeTo = (path) => path.startsWith(REPO) ? path.slice(REPO.length + 1) : path;

function packageDir(name) {
  const direct = join(EVAL, "node_modules", name);
  if (existsSync(join(direct, "package.json"))) return direct;
  const store = join(EVAL, "node_modules/.pnpm");
  const prefix = `${name.replace("/", "+")}@`;
  if (!existsSync(store)) return null;
  for (const entry of readdirSync(store)) if (entry.startsWith(prefix)) { const candidate = join(store, entry, "node_modules", name); if (existsSync(join(candidate, "package.json"))) return candidate; }
  return null;
}

function packageVersion(name) {
  const dir = packageDir(name);
  return dir === null ? null : JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
}

async function subcommand(report, values, script) {
  if (values.candidate !== "openorange" && !(script === "resilience" && values.candidate === undefined)) return { result: "blocked", reason: `only --candidate openorange is defined for ${script}; the native control is slice R4 (node scripts/rivet-eval.mjs native)` };
  if (!existsSync(join(EVAL, "node_modules/open-orange/dist/bin.js"))) return { result: "blocked", reason: "candidate bootstrap missing; run node scripts/rivet-eval.mjs bootstrap" };
  const noSandbox = values["no-sandbox"] === true;
  const soakArgs = script === "resilience" && values["soak-minutes"] !== undefined ? ["--soak-minutes", String(values["soak-minutes"]), "--reloads", String(values.reloads ?? "100")] : [];
  const done = spawnSync(process.execPath, [join(EVAL, `openorange/${script}.mts`), report.run.id, ...(noSandbox ? ["--no-sandbox"] : []), ...soakArgs], { encoding: "utf8", env: process.env, maxBuffer: 64 * 1024 * 1024 });
  process.stderr.write(done.stderr ?? "");
  const text = (done.stdout ?? "").trim();
  const detail = parseTail(text);
  const result = detail?.result ?? (done.status === 0 ? "pass" : "fail");
  const reason = detail?.reason ?? (done.status === 0 ? null : `${script} failed (exit ${done.status}); see stderr above`);
  const evidenceDir = join(RUNS, report.run.id);
  mkdirSync(evidenceDir, { recursive: true });
  const path = join(evidenceDir, `${script}.json`);
  writeFileSync(path, `${text || JSON.stringify({ result, reason })}\n`);
  return { result, reason, evidence: { path }, [script]: detail ?? { rawStdout: text } };
}

function parseTail(text) {
  const tail = text.lastIndexOf("\n{");
  for (const candidate of [text, tail === -1 ? text : text.slice(tail + 1)]) {
    try { return JSON.parse(candidate); } catch { /* try the next candidate */ }
  }
  return null;
}

function measureArm(report, pairs, rawName) {
  if (git("status", "--porcelain", "--untracked-files=no") !== "") return { result: "blocked", reason: "commit tracked changes before benchmarking a reproducible snapshot" };
  const dir = join(RUNS, report.run.id); mkdirSync(dir, { recursive: true }); const raw = join(dir, rawName);
  const done = spawnSync(process.execPath, [join(REPO, "cloudflare/bench/dev-loop.ts"), "--phase", "candidate", "--runs", String(pairs), "--out", raw], { encoding: "utf8", env: process.env });
  process.stderr.write(done.stdout ?? ""); process.stderr.write(done.stderr ?? "");
  if (done.status !== 0) return { result: "fail", reason: `dev-loop baseline arm failed (exit ${done.status}); see stderr above`, evidence: { path: raw } };
  return { result: "pass", evidence: { path: raw }, bench: JSON.parse(readFileSync(raw, "utf8")) };
}
function baseline(report, args) { const arm = measureArm(report, args.runs, "bench-candidate.json"); return arm.result === "pass" ? { result: "pass", reason: null, evidence: arm.evidence, baseline: arm.bench } : arm; }
function bench(report, values) {
  const pairs = Number(values.pairs ?? "7"); if (!Number.isInteger(pairs) || pairs < 7) return { result: "blocked", reason: "bench requires --pairs at least 7" };
  const arm = measureArm(report, pairs, "baseline-arm.json"); if (arm.result !== "pass") return arm;
  return { result: "blocked", reason: "candidate arm unavailable: cloudflare/bench/dev-loop.ts spawns only the Cloudflare stack (scripts/dev.ts), and no apples-to-apples OpenOrange dev-loop harness exists; the campaign bans building a general benchmark framework (R6). Seven interleaved A/B pairs could not be formed; performance verdict inconclusive. Retry: add a candidate phase to dev-loop.ts driving orange dev (readiness, frontend probe, backend/observe edit, process-tree RSS) and rerun: node scripts/rivet-eval.mjs bench --pairs 7 --json", evidence: arm.evidence, baseline: arm.bench, candidate: { available: false } };
}

async function main() {
  const started = Date.now();
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined || command === "--help") { console.log("usage: node scripts/rivet-eval.mjs <bootstrap|baseline|pilot|parity|native|resilience|bench|report> [options]"); process.exitCode = command === "--help" ? 0 : 2; return; }
  const { values } = parseArgs({ args: rest, options: { json: { type: "boolean" }, runs: { type: "string", default: "5" }, "soak-minutes": { type: "string" }, reloads: { type: "string" }, pairs: { type: "string" }, candidate: { type: "string" }, target: { type: "string" }, quick: { type: "boolean" }, check: { type: "boolean" }, "no-sandbox": { type: "boolean" } } });
  const runId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
  const report = base(command, runId);
  try {
    if (command === "bootstrap") Object.assign(report, bootstrap(report, values));
    else if (command === "baseline") Object.assign(report, baseline(report, values));
    else if (command === "bench") Object.assign(report, bench(report, values));
    else if (command === "pilot") Object.assign(report, await subcommand(report, values, "pilot"));
    else if (command === "parity") Object.assign(report, await subcommand(report, values, "parity"));
    else if (command === "resilience") Object.assign(report, await subcommand(report, values, "resilience"));
    else if (command === "native") Object.assign(report, await native(report, values));
    else if (SUITES[command]) { report.result = "blocked"; report.reason = `${command} is planned for campaign slice ${SUITES[command]} and is not implemented yet`; }
    else { report.result = "blocked"; report.reason = `unknown command: ${command}`; process.exitCode = 2; }
  } catch (error) { report.result = "fail"; report.reason = String(error?.message ?? error); }
  emit(report, started);
}

await main();
