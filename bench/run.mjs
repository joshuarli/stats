import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const tiers = ["edit", "change", "scenario", "full"];
const workloads = [
  { name: "harness", area: "harness", tier: "edit", command: ["node", "--test", "bench/observation-overhead-analysis.test.mjs", "bench/journey-coverage.test.mjs", "bench/observation-snapshot.test.mjs"], needs: [] },
  { name: "collection-small", area: "collection", tier: "change", command: ["node", "--experimental-strip-types", "cloudflare/bench/collection.ts", "small"], needs: ["cloudflare/bench/fixtures/collection.json"] },
  { name: "producer-queue", area: "producer", tier: "change", command: ["node", "--experimental-strip-types", "bench/producer-queue.ts", "256"], needs: [] },
  { name: "ingest-cpu", area: "ingest", tier: "scenario", command: ["node", "--experimental-strip-types", "cloudflare/bench/ingest-cpu.ts"], needs: [] },
  { name: "ingest-rows", area: "ingest", tier: "scenario", command: ["pnpm", "--dir", "cloudflare", "run", "bench:workerd", "ingest-rows"], needs: ["cloudflare/node_modules/.bin/vitest"] },
  { name: "local-counts", area: "local", tier: "scenario", command: ["make", "bench-local"], needs: ["cloudflare/node_modules/.bin/vite"] },
  { name: "dashboard", area: "dashboard", tier: "scenario", command: ["make", "dashboard-bench"], needs: ["cloudflare/node_modules/.bin/vite"] },
  { name: "ingest-protocol", area: "ingest", tier: "scenario", command: ["make", "ingest-bench"], needs: ["cloudflare/node_modules/.bin/vitest"] },
  { name: "agent-linux", area: "agent", tier: "full", excluded: "Needs a named Linux host and an explicitly selected agent binary; use bench/bench.sh as documented." },
  { name: "native-observation", area: "observe", tier: "full", excluded: "Needs the authorized private fixture, isolated Linux host, credentials and forwarding described in bench/README.md." },
  { name: "native-recovery", area: "observe", tier: "full", excluded: "Needs an authorized recovery cohort and private fixture described in bench/README.md." },
  { name: "application-summary", area: "observe", tier: "full", excluded: "Needs the named Linux production-image host and private application fixture." }
];
async function runWorkload(command) {
  const child = spawn(command[0], command.slice(1), { cwd: root, detached: true, env: { ...process.env, TMPDIR: join(root, ".work/tmp") }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", reason, interrupted, escalation;
  const killGroup = signal => { if (child.pid !== undefined) { try { process.kill(-child.pid, signal); } catch {} } };
  const stop = why => {
    reason ??= why;
    killGroup("SIGTERM");
    escalation ??= setTimeout(() => killGroup("SIGKILL"), 2000);
  };
  const timer = setTimeout(() => stop("workload timed out"), 600_000);
  const onInt = () => { interrupted = "SIGINT"; stop("interrupted"); };
  const onTerm = () => { interrupted = "SIGTERM"; stop("terminated"); };
  process.once("SIGINT", onInt);
  process.once("SIGTERM", onTerm);
  const collect = chunk => {
    if (output.length + chunk.length > 32 * 1024 * 1024) stop("workload output exceeded 32 MiB");
    else output += chunk;
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const result = await new Promise(resolveResult => {
    child.once("error", error => resolveResult({ exit: 1, output: `${output}\n${error.message}` }));
    child.once("close", (code, signal) => resolveResult({ exit: reason || signal ? 1 : code, output: `${output}${reason ? `\n${reason}\n` : ""}` }));
  });
  clearTimeout(timer);
  if (escalation !== undefined) clearTimeout(escalation);
  process.removeListener("SIGINT", onInt);
  process.removeListener("SIGTERM", onTerm);
  killGroup("SIGTERM");
  if (interrupted) { process.kill(process.pid, interrupted); }
  return result;
}
const usage = `usage: node bench/run.mjs [--list | --check | --dry-run] [--tier edit|change|scenario|full] [--name NAME] [--area AREA] [--skip NAME] [--full]\n\nSelect one workload: node bench/run.mjs --tier change --name collection-small\nList workloads: node bench/run.mjs --list\nFull requires --full and remains manual; excluded external studies have their own documented commands.\n`;
const args = process.argv.slice(2);
let mode = "run", tier = "edit", name, area, skip, full = false;
try {
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    let arg = args[i];
    const equals = arg.indexOf("=");
    let inline;
    if (equals !== -1) { inline = arg.slice(equals + 1); arg = arg.slice(0, equals); }
    if (seen.has(arg)) throw new Error(`repeated option ${arg}`);
    seen.add(arg);
    if ((arg === "--help" || arg === "-h") && inline === undefined) { process.stdout.write(usage); process.exit(0); }
    if (inline === undefined && ["--list", "--check", "--dry-run"].includes(arg)) { if (mode !== "run") throw new Error("choose one mode"); mode = arg.slice(2); continue; }
    if (arg === "--full" && inline === undefined) { full = true; continue; }
    if (!["--tier", "--name", "--area", "--skip"].includes(arg)) throw new Error(`invalid argument ${arg}`);
    const value = inline ?? args[++i];
    if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value`);
    if (arg === "--tier") tier = value;
    if (arg === "--name") name = value;
    if (arg === "--area") area = value;
    if (arg === "--skip") skip = value;
  }
  if (!tiers.includes(tier)) throw new Error(`unknown tier ${tier}`);
  if (name && !workloads.some(w => w.name === name)) throw new Error(`unknown workload ${name}`);
  if (area && !workloads.some(w => w.area === area)) throw new Error(`unknown area ${area}`);
  if (skip && !workloads.some(w => w.name === skip)) throw new Error(`unknown skip ${skip}`);
  if (tier === "full" && !full && mode !== "list") throw new Error("full requires --full");
  if (mode === "list") { for (const w of workloads) console.log(`${w.tier}\t${w.area}\t${w.name}\t${w.excluded ?? w.command.join(" ")}`); process.exit(0); }
  const selected = workloads.filter(w => tiers.indexOf(w.tier) <= tiers.indexOf(tier) && (!name || w.name === name) && (!area || w.area === area) && w.name !== skip);
  if (!selected.length) throw new Error("selection matches no workloads");
  const runnable = selected.filter(w => !w.excluded);
  for (const w of selected) console.log(w.excluded ? `${w.name}: excluded: ${w.excluded}` : `${w.name}: ${w.command.join(" ")}`);
  if (!runnable.length) throw new Error("selection contains no runnable workloads");
  if (mode === "dry-run") process.exit(0);
  const errors = [];
  if (process.version !== `v${(await import("node:fs")).readFileSync(join(root, ".node-version"), "utf8").trim()}`) errors.push("select the Node version in .node-version");
  for (const w of runnable) for (const need of w.needs) if (!existsSync(join(root, need))) errors.push(`${w.name}: missing ${need}; install locked dependencies or restore the fixture`);
  for (const binary of new Set(runnable.map(w => w.command[0]))) if (spawnSync("which", [binary], { stdio: "ignore" }).status !== 0) errors.push(`missing ${binary}`);
  if (errors.length) { for (const error of errors) console.error(error); process.exit(1); }
  const ready = spawnSync("perf-gate-ready", [], { encoding: "utf8" });
  console.log(`host readiness: ${ready.status === 0 ? "ready" : "busy or unavailable"}`);
  if (mode === "check") process.exit(0);
  const dir = join(root, ".work", "tmp", `bench-${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const results = [];
  for (const w of runnable) {
    const start = performance.now();
    const child = await runWorkload(w.command);
    writeFileSync(join(dir, `${w.name}.log`), child.output);
    results.push({ name: w.name, exit: child.exit, durationMs: Math.round(performance.now() - start), timing: "completion only; no performance verdict" });
    console.log(`${w.name}: exit ${child.exit}; log ${join(dir, `${w.name}.log`)}`);
  }
  const endReady = spawnSync("perf-gate-ready", ["-1"], { encoding: "utf8" });
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout?.trim();
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout?.trim() !== "";
  const exclusions = workloads.filter(w => !runnable.includes(w)).map(w => ({ name: w.name, reason: w.excluded ?? "outside selection" }));
  writeFileSync(join(dir, "summary.json"), JSON.stringify({ revision, dirty, node: process.version, platform: process.platform, arch: process.arch, results, exclusions, hostReady: ready.status === 0 && endReady.status === 0 }, null, 2) + "\n");
  if (results.some(r => r.exit !== 0)) process.exit(1);
} catch (error) { console.error(`${error.message}\n${usage}`); process.exit(2); }
