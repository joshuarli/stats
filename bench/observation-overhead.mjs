import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { analyzeOverhead } from "./observation-overhead-analysis.mjs";

const exec = promisify(execFile);
const { values } = parseArgs({ options: { "auth-file": { type: "string" }, output: { type: "string" }, diagnostic: { type: "boolean", default: false }, "diagnostic-cycles": { type: "string" } } });
assert.ok(values["auth-file"] && values.output && !existsSync(values.output));
const diagnosticCycles = Number(values["diagnostic-cycles"] ?? "1");
assert.ok(Number.isSafeInteger(diagnosticCycles) && diagnosticCycles >= 1 && diagnosticCycles <= 20 && (values.diagnostic || values["diagnostic-cycles"] === undefined));
const auth = JSON.parse(readFileSync(values["auth-file"], "utf8"));
assert.match(auth.secret, /^[A-Za-z0-9_-]{32,128}$/u);
const scratch = resolve(import.meta.dirname, "../.work/tmp"); mkdirSync(scratch, { recursive: true });
const init = resolve(scratch, `observation-study-${process.pid}.js`);
const sessions = [], controller = new AbortController(), rounds = [], gates = [];
const tools = Object.fromEntries(["./observation-overhead.mjs", "./observation-overhead-probe.js", "./observation-overhead-analysis.mjs"].map(path => [path, createHash("sha256").update(readFileSync(new URL(path, import.meta.url))).digest("hex")]));
const study = { diagnostic: values.diagnostic, node: process.version, tools, rounds, gates, collectorFailure: null, error: null };
let interrupted, closing = false, started = false;
const proxy = createServer((request, response) => {
  const upstream = httpRequest({ hostname: "127.0.0.1", port: 18787, path: request.url, method: request.method, headers: { ...request.headers, "Stats-Gateway-Secret": auth.secret, "Stats-Tailnet-Identity": "user:benchmark@example.invalid" } }, incoming => {
    response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response);
  });
  upstream.setTimeout(60000, () => upstream.destroy(new Error("fixture proxy timeout")));
  upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
  response.once("close", () => { if (!response.writableFinished) upstream.destroy(); });
  request.pipe(upstream);
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) process.once(signal, () => { interrupted = signal; controller.abort(); });
const pause = ms => new Promise(done => setTimeout(done, ms));
async function command(file, args, input) {
  const pending = exec(file, args, { timeout: 120000, maxBuffer: 16 * 1024 * 1024, ...(closing ? {} : { signal: controller.signal }) });
  pending.child.stdin.end(input ?? "");
  return (await pending).stdout.trim();
}
const browser = (session, args, input) => command("agent-browser", ["--session", session, ...args], input);
const decode = text => { const value = JSON.parse(text); return typeof value === "string" ? JSON.parse(value) : value; };
async function control(path, body) {
  const response = await fetch(`http://127.0.0.1:18790${path}`, { headers: { "Stats-Gateway-Secret": auth.secret }, signal: closing ? AbortSignal.timeout(180000) : AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]), ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  assert.equal(response.status, 200, "private study action failed; protected server evidence retained");
  return response.json();
}
async function gate(host, post, context) {
  let exitCode = 0, output = "";
  try { output = await command(host === "mac" ? "perf-gate-ready" : "ssh", host === "mac" ? (post ? ["-1"] : []) : ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "lisa", "/home/josh/.local/bin/perf-gate-ready", ...(post ? ["-1"] : [])]); }
  catch (error) { exitCode = Number.isInteger(error.code) ? error.code : -1; output = error.stderr ?? "gate unavailable"; }
  gates.push({ host, post, ...context, exitCode });
  writeFileSync(`${values.output}.${context.variant}-${context.round}-${host}-${post ? "post" : "pre"}.log`, output, { mode: 0o600 });
  return exitCode === 0;
}
async function clients(cycles) {
  const outcomes = await Promise.allSettled(sessions.map(async session => {
    await browser(session, ["open", "http://127.0.0.1:18887/#/projects"]);
    await browser(session, ["wait", "--fn", "Boolean(window.observationStudy && document.querySelector('table[aria-label=Projects]'))"]);
    await browser(session, ["eval", "--stdin"], `window.observationStudy.status={done:false};window.observationStudy.run(${cycles}).then(result=>window.observationStudy.status={done:true,result}).catch(error=>window.observationStudy.status={done:true,result:{ok:false,error:String(error),samples:[]}});'started'`);
    const deadline = Date.now() + 600000;
    while (Date.now() < deadline) {
      const status = decode(await browser(session, ["eval", "--stdin"], "window.observationStudy.status"));
      if (status.done) return status.result;
      await pause(250);
    }
    throw new Error("dashboard client deadline");
  }));
  return outcomes.map(outcome => outcome.status === "fulfilled" ? outcome.value : { ok: false, error: String(outcome.reason), samples: [] });
}
async function run(variant, round, cycles) {
  started = true;
  const prepared = await control(`/start?variant=${variant}&round=${round}`);
  study.fixture = { ...prepared.fixture, browserOrigin: "http://127.0.0.1:18887", transport: "authenticated loopback proxy through SSH tunnel to isolated container on Lisa" };
  const bootstrap = `Date.now=()=>${prepared.browser.nowMs};\n`;
  writeFileSync(init, bootstrap + readFileSync(new URL("./observation-overhead-probe.js", import.meta.url), "utf8"), { mode: 0o600 });
  if (!sessions.length) {
    const prefix = await command("agent-browser", ["session", "id", "--scope", "worktree", "--prefix", "stats-observation"]);
    for (let client = 0; client < 10; client++) {
      const session = `${prefix}-${client}`; sessions.push(session);
      await browser(session, ["--init-script", init, "open", "http://127.0.0.1:18887/#/projects"]);
    }
  }
  const context = { variant, round };
  const pre = await Promise.all([gate("mac", false, context), gate("lisa", false, context)]);
  if (!values.diagnostic && variant !== "collector-failure" && pre.some(passed => !passed)) throw new Error("perf gate deferred: host busy");
  await control("/begin");
  const browsers = await clients(cycles);
  study.pendingAttempt = { variant, round, browsers };
  const server = await control("/end");
  const post = await Promise.all([gate("mac", true, context), gate("lisa", true, context)]);
  const deliveries = await Promise.all(sessions.map(session => browser(session, ["eval", "--stdin"], "window.observationStudy.delivery").then(decode)));
  for (let index = 0; index < browsers.length; index++) browsers[index].delivery = deliveries[index];
  const samples = browsers.flatMap(browser => browser.samples);
  const exact = await control("/validate", samples);
  const uncached = samples.filter(sample => !sample.cached);
  const ranges = Object.fromEntries(["1h", "6h", "24h", "7d"].map(range => [range, { cached: samples.filter(sample => sample.range === range && sample.cached).length, uncached: samples.filter(sample => sample.range === range && !sample.cached).length }]));
  const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
  const rangeLatencyMs = Object.fromEntries(Object.keys(ranges).map(range => { const values = uncached.filter(sample => sample.range === range).map(sample => sample.latencyMs); return [range, { p50: percentile(values, .5), p95: percentile(values, .95), p99: percentile(values, .99) }]; }));
  const uiDelivery = deliveries.reduce((total, item) => ({ attempted: total.attempted + item.attempted, failed: total.failed + item.failed, pending: total.pending + item.pending, dropped: total.dropped + item.dropped }), { attempted: 0, failed: 0, pending: 0, dropped: 0 });
  const result = { ...server, hostGatesPassed: [...pre, ...post].every(Boolean), clients: browsers.length, browserFailures: browsers.filter(browser => !browser.ok).length, requests: browsers.reduce((total, browser) => total + (browser.reads ?? 0), 0), ranges, rangeLatencyMs, uiDelivery, latencyMs: uncached.reduce((total, sample) => total + sample.latencyMs, 0) / uncached.length, exact: server.exact && exact.exact, browsers };
  if (result.browserFailures || exact.checked !== 40 * cycles) study.failedAttempt = result;
  assert.ok(result.browserFailures === 0 && exact.checked === 40 * cycles, "all ten browsers must finish all requested journeys");
  delete study.pendingAttempt;
  return result;
}
try {
  await new Promise((done, reject) => { proxy.once("error", reject); proxy.listen(18887, "127.0.0.1", done); });
  for (let round = 0; round < (values.diagnostic ? 1 : 5); round++) for (const variant of ["disabled", "enabled"]) {
    const result = await run(variant, round, values.diagnostic ? diagnosticCycles : 20);
    rounds.push(result);
    console.log(JSON.stringify({ round, variant, requests: result.requests, ingested: result.ingested, browserFailures: result.browserFailures, diagnostic: values.diagnostic }));
    if (!values.diagnostic && !result.hostGatesPassed) throw new Error("perf gate deferred: host busy");
  }
  const failed = await run("collector-failure", 0, 1);
  const baseline = rounds.find(row => row.variant === "disabled");
  study.collectorFailure = { exactOutcomes: failed.exact && JSON.stringify(failed.outcomes) === JSON.stringify(baseline.outcomes), failedExports: failed.failedExports, result: failed };
} catch (error) { study.error = String(error); }
finally {
  closing = true;
  if (started) { try { await control("/stop"); } catch { study.error ??= "study server cleanup failed"; } }
  const closed = await Promise.allSettled(sessions.map(session => browser(session, ["close"])));
  if (closed.some(result => result.status === "rejected")) study.error ??= "browser cleanup failed";
  if (existsSync(init)) unlinkSync(init);
  proxy.closeAllConnections(); await new Promise(done => proxy.close(done));
  study.error ??= interrupted ? `interrupted by ${interrupted}` : null;
  study.analysis = analyzeOverhead(study);
  writeFileSync(values.output, JSON.stringify(study) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ diagnostic: values.diagnostic, analysis: study.analysis }));
  if (study.error || !values.diagnostic && !study.analysis.valid) process.exitCode = 1;
  if (interrupted) { process.removeAllListeners(interrupted); process.kill(process.pid, interrupted); }
}
