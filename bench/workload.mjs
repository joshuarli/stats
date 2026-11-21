import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";

const SAMPLE_MS = 500;

export function parsePsCpuMs(text) {
  const [days, clock] = text.includes("-") ? text.split("-") : ["0", text];
  const parts = clock.split(":").map(Number);
  if (parts.some(Number.isNaN) || parts.length < 2 || parts.length > 3) throw new Error(`unrecognized ps time ${text}`);
  const [hours, minutes, seconds] = parts.length === 3 ? parts : [0, ...parts];
  return Math.round((((Number(days) * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000);
}

export function parsePs(text) {
  const processes = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u.exec(line);
    if (match) processes.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), rssBytes: Number(match[4]) * 1024, cpuMs: parsePsCpuMs(match[5]), command: basename(match[6].trim()) });
  }
  return processes;
}

export function workloadMembers(processes, rootPid, known) {
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of processes) {
      if (known.has(p.pid) || !(p.pgid === rootPid || known.has(p.ppid))) continue;
      known.add(p.pid);
      grew = true;
    }
  }
  return processes.filter(p => known.has(p.pid)).map(({ pid, rssBytes, cpuMs, command }) => ({ pid, rssBytes, cpuMs, command }));
}

export function attributeSamples(samples) {
  const byPid = new Map();
  let peakGroupRssBytes = 0;
  for (const sample of samples) {
    peakGroupRssBytes = Math.max(peakGroupRssBytes, sample.reduce((sum, p) => sum + p.rssBytes, 0));
    for (const p of sample) {
      const seen = byPid.get(p.pid);
      const exited = /^(?:\(.*\)|<defunct>)$/u.test(p.command);
      const command = exited ? seen?.command ?? p.command.replace(/^\((.*)\)$/u, "$1") : p.command;
      byPid.set(p.pid, { command, cpuMs: Math.max(seen?.cpuMs ?? 0, p.cpuMs), rssBytes: Math.max(seen?.rssBytes ?? 0, p.rssBytes) });
    }
  }
  const byCommand = new Map();
  for (const p of byPid.values()) {
    const total = byCommand.get(p.command) ?? { command: p.command, processes: 0, cpuMs: 0, peakRssBytes: 0 };
    total.processes++;
    total.cpuMs += p.cpuMs;
    total.peakRssBytes = Math.max(total.peakRssBytes, p.rssBytes);
    byCommand.set(p.command, total);
  }
  return {
    method: `ps samples every ${SAMPLE_MS} ms of the workload's process group and every process started by a member; CPU is a lower bound that misses work after the last sample and processes shorter than one interval`,
    samples: samples.length,
    peakGroupRssBytes,
    commands: [...byCommand.values()].sort((a, b) => b.cpuMs - a.cpuMs || a.command.localeCompare(b.command)),
  };
}

function samplePs() {
  return new Promise(resolveSample => execFile("ps", ["-A", "-o", "pid=,ppid=,pgid=,rss=,time=,comm="], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => resolveSample(error ? undefined : parsePs(stdout))));
}

export async function runWorkload({ root, command, resourcePath, attribute = false, timeoutMs = 600_000 }) {
  rmSync(resourcePath, { force: true });
  const child = spawn("python3", ["-I", join(root, "bench/rusage.py"), resourcePath, ...command], { cwd: root, detached: true, env: { ...process.env, TMPDIR: join(root, ".work/tmp") }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", reason, interrupted, escalation, sampling = false;
  const samples = [], known = new Set();
  const killGroup = signal => {
    if (child.pid === undefined) return false;
    try { process.kill(-child.pid, signal); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw error; }
  };
  const stop = why => {
    reason ??= why;
    killGroup("SIGTERM");
    escalation ??= setTimeout(() => killGroup("SIGKILL"), 2000);
  };
  const sample = async () => {
    if (sampling || child.pid === undefined) return;
    sampling = true;
    const processes = await samplePs();
    const members = processes === undefined ? [] : workloadMembers(processes, child.pid, known);
    if (members.length) samples.push(members);
    sampling = false;
  };
  const sampler = attribute ? setInterval(sample, SAMPLE_MS) : undefined;
  if (attribute) void sample();
  const timer = setTimeout(() => stop("workload timed out"), timeoutMs);
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
  clearInterval(sampler);
  if (attribute) await sample();
  if (killGroup("SIGTERM")) {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && killGroup(0)) await new Promise(resolveWait => setTimeout(resolveWait, 50));
    if (killGroup(0)) killGroup("SIGKILL");
  }
  if (escalation !== undefined) clearTimeout(escalation);
  process.removeListener("SIGINT", onInt);
  process.removeListener("SIGTERM", onTerm);
  if (interrupted) { process.kill(process.pid, interrupted); }
  const waited = existsSync(resourcePath) ? { scope: "the workload and every descendant its parent waited for; peak RSS is the largest single process", ...JSON.parse(readFileSync(resourcePath, "utf8")) } : undefined;
  return { ...result, resources: { waited, attribution: attribute ? attributeSamples(samples) : undefined } };
}

const git = (root, args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });

function checkTracked(root, path) {
  if (!git(root, ["ls-files", "--", path]).stdout.trim()) return { error: `${path} is not tracked; restore the committed fixture` };
  const status = git(root, ["status", "--porcelain", "--untracked-files=all", "--", path]);
  if (status.status !== 0 || status.stdout.trim()) return { error: `${path} differs from HEAD; restore or commit the fixture before measuring` };
  return { identity: { kind: "tracked", path, object: git(root, ["rev-parse", `HEAD:${path}`]).stdout.trim() } };
}

function checkInstall(root) {
  const installedPath = join(root, "node_modules/.pnpm/lock.yaml");
  if (!existsSync(installedPath)) return { error: "dependencies are not installed; run pnpm install --frozen-lockfile" };
  const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
  const documents = lockfile.split(/^---\n/mu).filter(Boolean);
  if (!documents.includes(readFileSync(installedPath, "utf8"))) return { error: "installed dependencies do not match pnpm-lock.yaml; run pnpm install --frozen-lockfile" };
  return { identity: { kind: "install", lockfileObject: git(root, ["hash-object", "pnpm-lock.yaml"]).stdout.trim() } };
}

function checkBrowser(root) {
  let executable;
  try { executable = createRequire(join(root, "cloudflare/package.json"))("@playwright/test").chromium.executablePath(); }
  catch (error) { return { error: `cannot resolve the Playwright browser: ${error.message}` }; }
  if (!existsSync(executable)) return { error: `Playwright Chromium is not installed at ${executable}; run pnpm --dir cloudflare exec playwright install chromium` };
  return { identity: { kind: "browser", executable } };
}

function checkTool(tool) {
  return spawnSync("which", [tool], { stdio: "ignore" }).status === 0 ? { identity: { kind: "tool", tool } } : { error: `missing ${tool}` };
}

export function checkNeeds(root, needs) {
  const errors = [], identities = [];
  for (const need of needs) {
    const result = need.tracked !== undefined ? checkTracked(root, need.tracked)
      : need.install ? checkInstall(root)
      : need.browser ? checkBrowser(root)
      : need.tool !== undefined ? checkTool(need.tool)
      : { error: `unknown need ${JSON.stringify(need)}` };
    if (result.error) errors.push(result.error);
    else identities.push(result.identity);
  }
  return { errors, identities };
}
