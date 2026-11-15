import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { openAssets } from "../cloudflare/src/node/assets.ts";

const execute = promisify(execFile);
const { values } = parseArgs({ options: { baseline: { type: "string" }, candidate: { type: "string" }, origin: { type: "string" }, metadata: { type: "string" }, output: { type: "string" }, "per-range": { type: "string", default: "200" } } });
assert.ok(values.baseline && values.candidate && values.origin && values.metadata && values.output, "--baseline ASSETS --candidate ASSETS --origin HTTPS_ORIGIN --metadata CAPTURE_METADATA --output FILE are required");
const count = Number(values["per-range"]);
assert.ok(Number.isSafeInteger(count) && count >= 5 && count <= 2000 && count % 5 === 0);
const origin = new URL(values.origin);
assert.ok(origin.protocol === "https:" && origin.pathname === "/" && !origin.search && !origin.hash && !origin.username && !origin.password);
const capture = JSON.parse(readFileSync(values.metadata, "utf8"));
assert.ok(capture.complete === true && Number.isSafeInteger(capture.fromMs) && Number.isSafeInteger(capture.toMs) && capture.fromMs < capture.toMs);
assert.ok(Number.isSafeInteger(capture.firstAtMs) && capture.firstAtMs > capture.fromMs + 3_600_000, "a safe historical corpus extent is required for live comparisons");
const sha = body => createHash("sha256").update(body).digest("hex");
const servers = [], sessions = [], responseHashes = new Map(), rounds = [], gates = [];
const roots = { baseline: resolve(values.baseline), candidate: resolve(values.candidate) };
const urls = {};
let failures = 0;
let closing = false, interrupted;
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) process.on(signal, () => { interrupted ??= signal; controller.abort(); });

async function browser(session, args, input) {
  const pending = execute("agent-browser", ["--session", session, ...args], { maxBuffer: 4 * 1024 * 1024, timeout: 90_000, ...(closing ? {} : { signal: controller.signal }) });
  pending.child.stdin.end(input ?? "");
  return (await pending).stdout.trim();
}

function decoded(text) {
  const data = JSON.parse(text);
  return typeof data === "string" ? JSON.parse(data) : data;
}

async function gate(args) {
  try { const result = await execute("perf-gate-ready", args); gates.push({ args, exitCode: 0, detail: result.stdout + result.stderr }); }
  catch (error) { gates.push({ args, exitCode: error.code, detail: error.stdout + error.stderr }); throw new Error("perf gate deferred: host busy"); }
}

function install() {
  const state = { reads: 0, pending: 0, expected: {}, records: [], events: [] };
  window.rangeBench = state;
  const original = window.fetch;
  window.fetch = async (...args) => {
    if (!String(args[0]).includes("telemetry/summary")) return original(...args);
    state.reads++; state.pending++;
    try { return await original(...args); } finally { state.pending--; }
  };
  window.addEventListener("stats:project-journey", event => { if (state.events.length < 12000) state.events.push(event.detail); });
  state.step = async (name, warming = false) => {
    if (document.visibilityState !== "visible") throw new Error("benchmark tab is hidden");
    const reads = state.reads, started = performance.now();
    [...document.querySelectorAll("button")].find(button => button.textContent === name).click();
    if (warming) {
      let ready = false;
      for (let attempt = 0; attempt < 1200; attempt++) {
        await new Promise(done => setTimeout(done, 50));
        if (state.pending === 0 && document.querySelector(".native-overview[aria-busy=false]") && document.querySelectorAll(".native-overview canvas").length === 3) { ready = true; break; }
      }
      if (!ready) throw new Error("warmup did not complete");
    }
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 0))));
    const ms = performance.now() - started, pill = document.querySelector(".project-pills button")?.textContent;
    if (!pill || !document.querySelector(".native-overview[aria-busy=false]") || document.querySelectorAll(".native-overview canvas").length !== 3) throw new Error("overview incomplete");
    if (warming) state.expected[name] = pill;
    else {
      if (pill !== state.expected[name] || state.reads !== reads) throw new Error("cache output changed or fetched");
      state.records.push({ range: name, ms });
    }
  };
  state.warm = async () => { for (const name of ["1h", "6h", "24h", "7d", "30d"]) await state.step(name, true); return { reads: state.reads, expected: state.expected }; };
  state.run = async count => {
    const before = state.records.length;
    for (let n = 0; n < count; n++) await state.step(["1h", "6h", "24h", "7d", "30d"][n % 5]);
    return { records: state.records.slice(before), reads: state.reads, heapBytes: performance.memory?.usedJSHeapSize, graphs: document.querySelectorAll(".native-overview canvas").length };
  };
  return "installed";
}

try {
  const live = await fetch(origin, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) });
  assert.equal(live.status, 200);
  assert.equal(sha(Buffer.from(await live.arrayBuffer())), sha(readFileSync(resolve(roots.baseline, "index.html"))), "baseline entry assets differ from production");
  const scope = (await execute("agent-browser", ["session", "id", "--scope", "worktree", "--prefix", "stats-browser-bench"])).stdout.trim();
  for (const name of ["baseline", "candidate"]) {
    const assets = await openAssets(roots[name]);
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url, "http://127.0.0.1");
        let result;
        if (url.pathname.startsWith("/api/")) {
          if (request.method !== "GET" || !(/^\/api\/v1\/(capabilities|services|hosts)$/u.test(url.pathname) || url.pathname === "/api/observe/stats/external/telemetry/summary")) { response.writeHead(405).end(); return; }
          if (url.pathname.endsWith("/summary")) {
            const duration = Math.min(Number(url.searchParams.get("to")) - Number(url.searchParams.get("from")), capture.toMs - (capture.firstAtMs - 1));
            assert.ok(Number.isSafeInteger(duration) && duration > 0);
            url.searchParams.set("from", String(capture.toMs - duration)); url.searchParams.set("to", String(capture.toMs));
          }
          const headers = { accept: "application/json", ...(typeof request.headers.traceparent === "string" ? { traceparent: request.headers.traceparent } : {}) };
          result = await fetch(new URL(url.pathname + url.search, origin), { headers, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]) });
        } else result = await assets(new Request(url, { method: request.method }));
        const body = Buffer.from(await result.arrayBuffer());
        if (url.pathname.endsWith("/summary") && result.status === 200) {
          const key = url.search, hash = sha(body), previous = responseHashes.get(key);
          assert.ok(previous === undefined || previous === hash, "historical response changed between variants");
          responseHashes.set(key, hash);
        }
        response.writeHead(result.status, { "content-type": result.headers.get("content-type") ?? "application/octet-stream", "cache-control": "no-store", ...(result.headers.has("server-timing") ? { "server-timing": result.headers.get("server-timing") } : {}) });
        response.end(body);
      } catch { failures++; if (!response.headersSent) response.writeHead(502).end("benchmark read failed"); else response.destroy(); }
    });
    await new Promise(done => server.listen(0, "127.0.0.1", done)); servers.push(server);
    urls[name] = `http://127.0.0.1:${server.address().port}`;
    const session = `${scope}-${name}`; sessions.push(session);
    await browser(session, ["open", urls[name] + "/#/project/stats"]);
    await browser(session, ["eval", "--stdin"], `(${install.toString()})()`);
    await browser(session, ["eval", "--stdin"], "window.rangeBench.warmStatus={done:false};window.rangeBench.warm().then(result=>{window.rangeBench.warmStatus={done:true,result}}).catch(error=>{window.rangeBench.warmStatus={done:true,error:String(error)}});'started'");
  }
  for (const session of sessions) {
    let status;
    const deadline = Date.now() + 120_000;
    do {
      status = decoded(await browser(session, ["eval", "--stdin"], "window.rangeBench.warmStatus"));
      if (!status.done) await new Promise(done => setTimeout(done, 200));
    } while (!status.done && Date.now() < deadline);
    assert.ok(status.done && !status.error, status.error ?? "warmup deadline exceeded");
  }
  await gate([]);
  for (let round = 0; round < 5; round++) for (const name of (round % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"])) {
    const session = sessions[name === "baseline" ? 0 : 1];
    const data = decoded(await browser(session, ["eval", "--stdin"], `window.rangeBench.run(${count})`));
    rounds.push({ round, name, ...data });
  }
  await gate(["-1"]);
  const observations = decoded(await browser(sessions[1], ["eval", "--stdin"], "window.rangeBench.events"));
  const cached = observations.filter(event => event.cache && event.outcome === "ok");
  assert.equal(cached.length, count * 5, "each candidate interaction must have a completed measured journey");
  assert.equal(failures, 0);
  const sizes = {};
  for (const name of ["baseline", "candidate"]) sizes[name] = Number((await execute("du", ["-sk", roots[name]])).stdout.trim().split(/\s+/u)[0]) * 1024;
  writeFileSync(values.output, JSON.stringify({ valid: true, adequateSamples: count >= 200, corpus: capture, source: "identical historical summary responses from Lisa bounded to captured data extent, local production frontend assets, cached selections; not cold or full-retention acceptance", rounds, gates: gates.map(({ args, exitCode }) => ({ args, exitCode })), responseHashes: [...responseHashes], observations, sizes, harnessMemory: process.memoryUsage(), failures }) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ valid: true, adequateSamples: count >= 200, interactionsPerVariant: count * 5, completedCandidateJourneys: cached.length, failures }));
} finally {
  closing = true;
  for (const session of sessions) { try { await browser(session, ["close"]); } catch { failures++; } }
  for (const server of servers) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  if (interrupted !== undefined) { process.removeAllListeners(interrupted); process.kill(process.pid, interrupted); }
}
