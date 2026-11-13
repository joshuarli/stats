import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Browser, type Page } from "@playwright/test";
import { doctor } from "../scripts/dev-doctor.ts";
import { processOwner } from "../scripts/processes.ts";
import { accessToken } from "../test/access-token.ts";

const { values } = parseArgs({ options: { root: { type: "string" }, phase: { type: "string", default: "candidate" }, legacy: { type: "boolean" }, runs: { type: "string", default: "5" }, out: { type: "string" } } });
const originalRepo = resolve(import.meta.dirname, "../..");
const owner = processOwner("bench-dev");
let ownedCheckout: string | undefined;
if (values.root === undefined) {
  if (execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: originalRepo, encoding: "utf8" }).trim() !== "") throw new Error("commit tracked changes before benchmarking a reproducible snapshot");
  mkdirSync(join(originalRepo, ".work/tmp"), { recursive: true });
  ownedCheckout = mkdtempSync(join(originalRepo, ".work/tmp/bench-dev-checkout-"));
  try {
    await owner.run("checkout", "git", ["clone", "--shared", originalRepo, ownedCheckout], { stream: false });
    appendFileSync(join(ownedCheckout, ".git/info/exclude"), "\n.work/\n");
    await owner.run("bootstrap", "pnpm", ["install", "--offline", "--frozen-lockfile"], { cwd: ownedCheckout, stream: false });
  } catch (error) { await owner.close(); rmSync(ownedCheckout, { recursive: true, force: true }); throw error; }
}
const root = resolve(values.root ?? join(ownedCheckout!, "cloudflare"));
if (ownedCheckout === undefined && !root.includes("/.work/wt/")) throw new Error("benchmark --root must be an isolated .work/wt checkout; the benchmark removes its generated outputs");
process.env["STATS_DOMAIN"] ??= "stats.17166969.xyz";
const runs = Number(values.runs);
assert.ok(Number.isInteger(runs) && runs > 0);
const baseline = values.phase === "baseline" || values.legacy === true;
const scratch = resolve(root, "../.work/tmp");
mkdirSync(scratch, { recursive: true });
const state = mkdtempSync(join(scratch, "bench-dev-state-"));
let browser: Browser | undefined;
let page: Page;
const results: { scenario: string; elapsedMs: number; compilations: number; tests?: number }[] = [];
const memory: { readonly processes: number; readonly rssKiB: number }[] = [];
const inputs = [join(root, "src/client/styles/index.css"), join(root, "src/core/http.ts")];
const observeInputs = [join(root, "src/observe/http/api.ts")];
const originals = inputs.map(file => readFileSync(file, "utf8"));
const observeOriginals = observeInputs.map(file => readFileSync(file, "utf8"));
let running: ReturnType<typeof owner.start> | undefined;
let origin = "";

async function until(read: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = performance.now() + 30_000;
  while (!(await read())) {
    if (performance.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
}

function compiled(log: string): number { return (log.match(/building ssr environment for production/gu) ?? []).length; }
async function build(): Promise<number> {
  const result = await owner.run("build", process.execPath, ["scripts/build-all.mjs"], { cwd: root, env: process.env, stream: false });
  return compiled(readFileSync(result.logPath, "utf8"));
}

async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  await new Promise<void>(done => server.close(() => done()));
  return address.port;
}

async function start(): Promise<void> {
  const selectedPort = await port();
  running = owner.start("dev", process.execPath, baseline ? ["scripts/local-stack.mjs", "dev", "--state", state, "--port", String(selectedPort)] : ["scripts/dev.ts", "--state", state, "--port", "0"], { cwd: root, env: process.env, stream: false });
  const child = running;
  let output = "";
  child.child.stdout!.on("data", chunk => { output += String(chunk); });
  await Promise.race([
    until(async () => {
      if (baseline) {
        const match = /stats local stack: (http:\/\/127\.0\.0\.1:\d+)/u.exec(output);
        if (match !== null && output.includes("\nready\n")) { origin = match[1]!; return true; }
      } else {
        for (const line of output.split("\n")) {
          if (!line.startsWith("{")) continue;
          const status = JSON.parse(line) as { event?: string; origin?: string };
          if (status.event === "dev-ready" && status.origin !== undefined) { origin = status.origin; return true; }
        }
      }
      return false;
    }, "development readiness"),
    child.done.then(() => { throw new Error("dev exited before readiness"); })
  ]);
  const response = await page.request.get(`${origin}/api/v1/hosts`);
  assert.equal(response.status(), 200);
  const hosts = await response.json() as { hosts: unknown[] };
  assert.equal(hosts.hosts.length, 1);
}

async function stop(): Promise<void> {
  if (running === undefined) return;
  const child = running;
  running = undefined;
  child.kill("SIGTERM");
  await child.done.catch(() => {});
}

async function trial(scenario: string, work: () => Promise<{ compilations: number; tests?: number }>): Promise<void> {
  execFileSync("perf-gate-ready", [], { stdio: "pipe" });
  const started = performance.now();
  const result = await work();
  const elapsedMs = performance.now() - started;
  execFileSync("perf-gate-ready", ["-1"], { stdio: "pipe" });
  results.push({ scenario, elapsedMs, ...result });
  console.error(`bench: ${values.phase} ${scenario} complete (${result.compilations} compilations)`);
}

try {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ extraHTTPHeaders: { "cf-access-jwt-assertion": await accessToken() } });
  page.on("pageerror", error => console.error(`browser: ${error.message}`));
  for (let run = 0; run < runs; run += 1) {
    await stop();
    rmSync(state, { recursive: true, force: true });
    if (!baseline) rmSync(resolve(root, "../.work/tmp/builds"), { recursive: true, force: true });
    for (const path of [".cloudflare/output", "observe-worker/.cloudflare/output"]) rmSync(join(root, path), { recursive: true, force: true });
    await trial("cold-ready", async () => { const compilations = baseline ? await build() : 0; await start(); await page.goto(origin); await page.getByRole("table", { name: "Fleet hosts" }).waitFor(); return { compilations: compilations + (baseline ? 0 : compiled(readFileSync(running!.logPath, "utf8"))) }; });
    await stop();
    await trial("warm-ready", async () => { const compilations = baseline ? await build() : 0; await start(); await page.goto(origin); await page.getByRole("table", { name: "Fleet hosts" }).waitFor(); return { compilations: compilations + (baseline ? 0 : compiled(readFileSync(running!.logPath, "utf8"))) }; });
    const processes = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" }).trim().split("\n").map(line => line.trim().split(/\s+/u).map(Number));
    const selected = new Set([running!.child.pid!]);
    for (let previous = -1; previous !== selected.size;) { previous = selected.size; for (const [pid, parent] of processes) if (selected.has(parent!)) selected.add(pid!); }
    memory.push({ processes: selected.size, rssKiB: processes.filter(([pid]) => selected.has(pid!)).reduce((total, row) => total + row[2]!, 0) });
    const marker = `r${run}`;
    await trial("frontend-edit", async () => {
      const previous = compiled(readFileSync(running!.logPath, "utf8"));
      writeFileSync(inputs[0]!, `${originals[0]}\n:root { --dev-loop-probe: ${marker}; }\n`);
      let compilations = 0;
      if (baseline) { await stop(); compilations = await build(); await start(); await page.goto(origin); }
      await until(async () => (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--dev-loop-probe").trim())) === marker, "frontend edit in browser");
      return { compilations: baseline ? compilations : compiled(readFileSync(running!.logPath, "utf8")) - previous };
    });
    await trial("worker-edit", async () => {
      const previous = compiled(readFileSync(running!.logPath, "utf8"));
      const source = originals[1]!;
      assert.ok(source.includes('{ ok: true, service: "stats" }'));
      writeFileSync(inputs[1]!, source.replace('{ ok: true, service: "stats" }', `{ ok: true, service: "stats", devLoopProbe: "${marker}" }`));
      let compilations = 0;
      if (baseline) { await stop(); compilations = await build(); await start(); }
      await until(async () => { try { const response = await fetch(`${origin}/health`); return response.ok && (await response.json() as { devLoopProbe?: string }).devLoopProbe === marker; } catch { return false; } }, "Worker edit in successful request");
      return { compilations: baseline ? compilations : compiled(readFileSync(running!.logPath, "utf8")) - previous };
    });
    await trial("observation-edit", async () => {
      const previous = compiled(readFileSync(running!.logPath, "utf8"));
      const source = observeOriginals[0]!;
      const needle = "return json(await store.health());";
      assert.ok(source.includes(needle));
      writeFileSync(observeInputs[0]!, source.replace(needle, `return json({ ...(await store.health()), devLoopProbe: "${marker}" });`));
      let compilations = 0;
      if (baseline) { await stop(); compilations = await build(); await start(); }
      await until(async () => { try { const response = await page.request.get(`${origin}/api/observe/stats/health`); return response.ok() && (await response.json() as { devLoopProbe?: string }).devLoopProbe === marker; } catch { return false; } }, "observe edit in verified request");
      return { compilations: baseline ? compilations : compiled(readFileSync(running!.logPath, "utf8")) - previous };
    });
    await stop();
    for (const [index, input] of inputs.entries()) writeFileSync(input, originals[index]!);
    for (const [index, input] of observeInputs.entries()) writeFileSync(input, observeOriginals[index]!);
    for (const file of ["test/ingest/conformance.test.ts", "test/node/parity.test.ts"]) {
      await trial(file, async () => {
        const result = await owner.run("focused-test", process.execPath, ["scripts/run-tests.mjs", "--file", file], { cwd: root, env: process.env, stream: false });
        const log = readFileSync(result.logPath, "utf8");
        assert.match(log, /fail 0/u);
        return { compilations: compiled(log), tests: Number(/tests (\d+)/u.exec(log)?.[1]) };
      });
    }
    await trial("unchanged-build", async () => ({ compilations: await build() }));
  }
  const scenarios = [...new Set(results.map(result => result.scenario))].map(scenario => {
    const selected = results.filter(result => result.scenario === scenario);
    const times = selected.map(result => result.elapsedMs).sort((a, b) => a - b);
    return { scenario, runs: times.length, medianMs: times[Math.floor(times.length / 2)], minMs: times[0], maxMs: times.at(-1), compilations: selected.map(result => result.compilations), tests: selected.map(result => result.tests) };
  });
  const report = { phase: values.phase, ...doctor(root), harnessSha256: createHash("sha256").update(readFileSync(import.meta.filename)).digest("hex"), driverRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: originalRepo, encoding: "utf8" }).trim(), readinessScope: "server readiness, authenticated seeded API, and visible Fleet hosts table", buildEnvironment: { STATS_DOMAIN: process.env["STATS_DOMAIN"] }, fixtureGeneration: "committed fixtures; generation excluded; cold readiness includes seeding a new state directory", memory, memoryScope: "warm development process and descendants; browser and measurement driver excluded", frontendMode: baseline ? "manual build and restart" : "HMR", failures: 0, scenarios, results };
  const output = JSON.stringify(report, null, 2);
  if (values.out !== undefined) writeFileSync(values.out, `${output}\n`);
  console.log(output);
} finally {
  await stop();
  for (const [index, input] of inputs.entries()) writeFileSync(input, originals[index]!);
  for (const [index, input] of observeInputs.entries()) writeFileSync(input, observeOriginals[index]!);
  await browser?.close();
  await owner.close();
  rmSync(state, { recursive: true, force: true });
  if (ownedCheckout !== undefined) rmSync(ownedCheckout, { recursive: true, force: true });
}
