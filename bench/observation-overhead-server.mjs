import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, openSync, closeSync, readdirSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { cpus, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { inspect, parseArgs } from "node:util";
import { createProducer } from "../packages/producer/src/index.ts";
import { createBridgeServer } from "../packages/platform-bridge/src/server.ts";
import { constantTimeEqual, generateToken, tokenHash } from "../cloudflare/src/auth.ts";
import { reference } from "./application-reference.mjs";
import { processCpu } from "./observation-overhead-analysis.mjs";
import { captureObjectSnapshot } from "./observation-snapshot.mjs";

const { values } = parseArgs({ options: { root: { type: "string" }, "engine-sha256": { type: "string" }, "cpu-profile": { type: "boolean", default: false } } });
assert.equal(process.platform, "linux");
const root = resolve(values.root ?? "");
assert.ok(root.startsWith("/bench/") && /^[a-f0-9]{64}$/u.test(values["engine-sha256"] ?? ""));
const engineConfigPath = join(root, "engine/config.json");
const engineConfig = JSON.parse(readFileSync(engineConfigPath, "utf8"));
for (const path of [engineConfig.storage.log_directory, engineConfig.object_storage.primary.file_system.path]) assert.ok(resolve(path).startsWith(root + "/"), "private Engine storage must belong to the selected study root");
for (const role of ["guard", "api_peer", "metrics"]) assert.equal(engineConfig[role].host, "127.0.0.1");
assert.equal(new URL(engineConfig.topology.datacenters.default.public_url).origin, "http://127.0.0.1:44794");
const proof = JSON.parse(readFileSync(join(root, "fixture/native-scale-preparation.json"), "utf8"));
assert.equal(proof.events, 203950); assert.ok(proof.restoredSummaryEqual);
const corpus = JSON.parse(readFileSync(join(root, "fixture/corpus-10x.json"), "utf8"));
const events = corpus.events.map(event => ({ ...event, atMs: event.atMs + proof.shiftMs }));
const auth = JSON.parse(readFileSync(join(root, "fixture/native-scale-state/fixture-auth.json"), "utf8"));
const state = join(root, "fixture/native-scale-state");
const headers = { "Stats-Gateway-Secret": auth.secret, "Stats-Tailnet-Identity": "user:benchmark@example.invalid", "content-type": "application/json" };
const hash = value => createHash("sha256").update(value).digest("hex");
const tools = Object.fromEntries(["./observation-overhead-server.mjs", "./observation-overhead-analysis.mjs", "./observation-snapshot.mjs", "./application-reference.mjs", "../packages/platform-bridge/src/server.ts", "../packages/platform-bridge/src/project.ts", "../packages/producer/src/index.ts", "../packages/producer/src/protocol.ts", "../cloudflare/src/auth.ts"].map(path => [path, hash(readFileSync(new URL(path, import.meta.url)))]));
const canonical = value => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
assert.equal(hash(readFileSync(join(root, "engine/rivet-engine"))), values["engine-sha256"]);
const tickUs = 1000000 / Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
const descriptors = Object.fromEntries(["stats", "observe"].map(name => [name, JSON.parse(readFileSync(join(state, `${name}.jsonc`), "utf8"))]));
for (const name of ["stats", "observe"]) assert.equal(hash(readFileSync(descriptors[name].main)), proof.runtimeSources[name]);
const otlpToken = randomBytes(32).toString("hex"), platformToken = generateToken();
const runId = randomBytes(8).toString("hex");
const children = new Set();
const runtimeAbort = new AbortController();
let currentAction;
let rejectEngine;
const engineFailure = new Promise((_, reject) => { rejectEngine = reject; });
let app, engine, bridge, producer, control, capture, variant, round, before, ingestion, stopping = false, exportFailures = 0;
const selectors = new Map(), ingested = [], records = [];
const pause = ms => new Promise(done => setTimeout(done, ms));
function start(file, args, env, name) {
  assert.ok(!stopping, "study is stopping");
  const out = openSync(join(root, `${name}.stdout.log`), "a", 0o600), err = openSync(join(root, `${name}.stderr.log`), "a", 0o600);
  let child;
  try { child = spawn(file, args, { cwd: state, env: { ...process.env, ...env }, detached: true, stdio: ["ignore", out, err] }); }
  finally { closeSync(out); closeSync(err); }
  const owner = { child, name, done: false, status: null, stopPromise: null };
  owner.exited = new Promise(done => {
    child.once("exit", (code, signal) => { owner.done = true; owner.status = { code, signal }; done(); });
    child.once("error", error => { owner.done = true; owner.status = { error: error.code }; done(); });
  });
  children.add(owner);
  writeFileSync(join(root, "runtime-pids.json"), JSON.stringify([...children].map(owner => ({ name: owner.name, pid: owner.child.pid }))), { mode: 0o600 });
  return owner;
}
async function stop(owner) {
  if (!owner) return;
  return owner.stopPromise ??= (async () => {
    if (!owner.done) {
      try { process.kill(-owner.child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      let timer;
      await Promise.race([owner.exited, new Promise(done => { timer = setTimeout(done, 20000); })]); clearTimeout(timer);
      if (!owner.done) { process.kill(-owner.child.pid, "SIGKILL"); await owner.exited; }
    }
    children.delete(owner);
  })();
}
function startEngine() {
  assert.ok(!engine || engine.done, "previous private Engine still runs");
  const owner = start(join(root, "engine/rivet-engine"), ["--config", engineConfigPath], { RIVET__AUTH__ADMIN_TOKEN: auth.engineToken }, "engine-study");
  owner.exited.then(() => { if (!owner.stopPromise && !stopping) rejectEngine(new Error("private Engine exited")); });
  engine = owner;
}
async function request(path, body, extra = {}) {
  assert.ok(!stopping, "study is stopping");
  const response = await fetch(`http://127.0.0.1:8787${path}`, { headers: { ...headers, ...extra }, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }), signal: AbortSignal.any([runtimeAbort.signal, AbortSignal.timeout(30000)]) });
  const text = await response.text();
  try { return { status: response.status, body: JSON.parse(text) }; }
  catch { writeFileSync(join(root, "failed-response.txt"), text.slice(0, 65536), { mode: 0o600 }); throw new Error(`study API returned HTTP ${response.status} without JSON`); }
}
async function ready(url, owner, extra = {}) {
  const deadline = Date.now() + 120000;
  while (!stopping && !owner.done && Date.now() < deadline) {
    try { const response = await fetch(url, { headers: extra, signal: AbortSignal.timeout(2000) }); await response.body?.cancel(); if (response.status === 200) return; }
    catch {}
    await pause(100);
  }
  throw new Error("private runtime readiness failed");
}
function cpu(owner) {
  assert.ok(owner && !owner.done, "measured process exited");
  const snapshot = new Map();
  const pending = [owner.child.pid];
  while (pending.length) {
    const pid = pending.pop();
    const measured = processCpu(readFileSync(`/proc/${pid}/stat`, "utf8"));
    snapshot.set(pid, measured);
    for (const task of readdirSync(`/proc/${pid}/task`)) {
      const descendants = readFileSync(`/proc/${pid}/task/${task}/children`, "utf8").trim();
      for (const child of descendants ? descendants.split(/\s+/u).map(Number) : []) if (!snapshot.has(child) && !pending.includes(child)) pending.push(child);
    }
  }
  return snapshot;
}
function delta(started, ended) {
  assert.equal(ended.size, started.size, "measured process tree changed");
  let ticks = 0;
  for (const [pid, row] of ended) { const old = started.get(pid); assert.ok(old && old.start === row.start && row.ticks >= old.ticks, "measured process identity changed"); ticks += row.ticks - old.ticks; }
  return ticks * tickUs;
}
async function verify() {
  const windows = [];
  for (const hours of [1, 6, 24, 168]) {
    const result = await request(`/api/observe/stats/external/telemetry/summary?from=${proof.toMs - hours * 3600000}&to=${proof.toMs}`);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, reference(events, result.body.fromMs, result.body.toMs));
    assert.equal(result.body.toMs, proof.toMs);
    windows.push({ hours, fromMs: result.body.fromMs, toMs: result.body.toMs, events: result.body.totals.events, sha256: hash(JSON.stringify(result.body)) });
  }
  assert.equal(windows.at(-1).events, 203950);
  return windows;
}
async function application(nextVariant, nextRound) {
  assert.ok(!stopping, "study is stopping");
  assert.ok(["disabled", "enabled", "collector-failure"].includes(nextVariant) && !ingestion);
  if (producer) await producer.flush();
  if (bridge) { bridge.server.closeAllConnections(); await new Promise(done => bridge.server.close(done)); bridge = undefined; }
  if (producer) { await producer.shutdown(); producer = undefined; }
  await stop(app); app = undefined;
  variant = nextVariant; round = nextRound;
  const discovering = variant === "enabled" && selectors.size < 2;
  const profileDirectory = join(root, `cpu-${variant}-${round}`);
  if (values["cpu-profile"]) mkdirSync(profileDirectory, { recursive: true, mode: 0o700 });
  for (const [name, original] of Object.entries(descriptors)) {
    const descriptor = structuredClone(original);
    if (variant === "disabled") delete descriptor.vars.APPLICATION_EVENTS_RELEASE;
    else if (name === "stats") descriptor.vars.APPLICATION_EVENTS_RELEASE = "stats-6cc06db247a3";
    if (name === "stats") descriptor.vars.PLATFORM_BRIDGE_TOKEN_SHA256 = await tokenHash(platformToken);
    writeFileSync(join(state, `${name}.jsonc`), JSON.stringify(descriptor), { mode: 0o600 });
  }
  app = start(process.execPath, ["/orange/node_modules/open-orange/dist/bin.js", "serve", "--ip", "0.0.0.0", "--port", "8787", "--config", join(state, "stats.jsonc"), "--config", join(state, "observe.jsonc")], {
    ...(values["cpu-profile"] ? { NODE_OPTIONS: `--cpu-prof --cpu-prof-dir=${JSON.stringify(profileDirectory)}` } : {}),
    RIVET_ENDPOINT: "http://127.0.0.1:44794", RIVET_TOKEN: auth.engineToken, RIVET_NAMESPACE: proof.namespace, RIVET_NODE_VERSION: String(proof.nodeVersion), RIVET_LOG_LEVEL: "error", WRANGLER_LOG_PATH: join(root, `wrangler-${variant}-${round}.log`),
    OTEL_SDK_DISABLED: String(variant === "disabled"), OTEL_SERVICE_NAME: "stats-runtime-study", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:8791/v1/traces", OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json", OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${otlpToken}`, OTEL_TRACES_SAMPLER: "parentbased_traceidratio", OTEL_TRACES_SAMPLER_ARG: discovering ? "1" : "0.1", OTEL_BSP_MAX_QUEUE_SIZE: "256", OTEL_BSP_MAX_EXPORT_BATCH_SIZE: "64", OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: "1000", OTEL_RESOURCE_ATTRIBUTES: "service.version=study,openorange.version=1.0.2"
  }, `app-${variant}-${round}`);
  await ready("http://127.0.0.1:8787/api/v1/hosts", app, headers);
  await ready("http://127.0.0.1:8787/api/v1/admin/objects/observe:stats/maintenance", app, headers);
  const windows = await verify();
  if (variant !== "enabled") for (let index = 0; index < 64; index++) await request("/api/v1/hosts");
  if (variant === "enabled") {
    const deadline = Date.now() + 20000;
    while (selectors.size < 2 && Date.now() < deadline) { await request("/api/v1/hosts"); await verify(); await pause(250); }
    writeFileSync(join(root, `selector-startup-${round}.json`), JSON.stringify({ discovering, actors: [...selectors.values()] }), { mode: 0o600 });
    assert.equal(selectors.size, 2, "native actor selectors not observed");
    if (discovering) return application(nextVariant, nextRound);
    producer = createProducer({ endpoint: "http://127.0.0.1:8787", service: "stats-platform", token: platformToken, release: "study-bridge", queueLimit: 128, batchSize: 64, timeoutMs: 5000, maxRetries: 1 });
    bridge = createBridgeServer({ producer, token: otlpToken, policy: { resourceService: "stats-runtime-study", openorangeVersion: "1.0.2", rivetkitVersion: "3.1.2-rc.1", nativeVersion: "3.1.1", samplePpm: 100000, actors: [...selectors.values()] } });
    await new Promise(done => bridge.server.listen(8792, "127.0.0.1", done));
    for (let index = 0; index < 64; index++) await request("/api/v1/hosts");
    const delivered = Date.now() + 20000;
    while (!producer.stats().sent && Date.now() < delivered) { await verify(); await pause(250); await producer.flush(); }
    writeFileSync(join(root, `instrumentation-startup-${round}.json`), JSON.stringify({ receiver: bridge.counters(), producer: producer.stats() }), { mode: 0o600 });
    assert.ok(producer.stats().sent > 0, "instrumentation must deliver before measurement");
  }
  ingested.length = 0;
  return { ready: true, windows, fixture: { ...proof, exactReference: true, profiling: values["cpu-profile"], engineSha256: values["engine-sha256"], tools, node: process.version, cpuModel: cpus()[0].model, hostCores: cpus().length, hostMemoryBytes: totalmem(), cpuTickUs: tickUs, openorangeVersion: JSON.parse(readFileSync("/orange/node_modules/open-orange/package.json", "utf8")).version }, browser: { nowMs: proof.toMs } };
}
async function batch(sequence) {
  const batch = Array.from({ length: 64 }, (_, index) => ({ ...events[Math.floor((sequence * 64 + index) * events.length / 1024)], eventId: `study-${runId}-${variant}-${round}-${sequence}-${index}`, atMs: Date.now() - 1000, release: "study-ingest" }));
  const result = await request("/ingest/observe/v1/stats/batches", { events: batch }, { authorization: `Bearer ${auth.ingestToken}` });
  assert.equal(result.status, 202); assert.equal(result.body.accepted, batch.length); assert.equal(result.body.duplicate, 0);
  ingested.push(...batch);
}
function memoryEvents() { return Object.fromEntries(readFileSync("/sys/fs/cgroup/memory.events", "utf8").trim().split("\n").map(line => line.split(" ").map((value, index) => index ? Number(value) : value))); }
async function begin() {
  assert.ok(app && !ingestion && !before);
  before = { stats: cpu(app), engine: cpu(engine), collector: process.cpuUsage(), memory: memoryEvents(), received: bridge?.counters().received ?? 0, sent: producer?.stats().sent ?? 0, failures: exportFailures, stderrBytes: readFileSync(join(root, `${app.name}.stderr.log`)).length, started: performance.now() };
  const owner = { stopping: false, failure: null };
  owner.done = (async () => { try { for (let sequence = 0; sequence < 16 && !owner.stopping && !stopping; sequence++) { await batch(sequence); await pause(250); } } catch (error) { owner.failure = error; } })();
  ingestion = owner;
}
async function finish() {
  assert.ok(ingestion && before);
  await ingestion.done;
  const failure = ingestion.failure; ingestion = undefined;
  if (failure) throw failure;
  await pause(6000); await producer?.flush();
  const after = { stats: cpu(app), engine: cpu(engine), collector: process.cpuUsage(before.collector), memory: memoryEvents() };
  const stderr = readFileSync(join(root, `${app.name}.stderr.log`)).subarray(before.stderrBytes).toString();
  const applicationDeliveryFailures = [...stderr.matchAll(/"event":"application_(?:event_failed|delivery_loss)"/gu)].length;
  const measured = { round, variant, statsCpuUs: delta(before.stats, after.stats), engineCpuUs: delta(before.engine, after.engine), collectorAndDriverCpuUs: after.collector.user + after.collector.system, elapsedMs: performance.now() - before.started, memoryBytes: Number(readFileSync("/sys/fs/cgroup/memory.current", "utf8")), memoryOom: after.memory.oom - before.memory.oom, collectorReceived: (bridge?.counters().received ?? 0) - before.received, collectorSent: (producer?.stats().sent ?? 0) - before.sent, failedExports: exportFailures - before.failures, applicationDeliveryFailures, ingested: ingested.length };
  before = undefined;
  assert.equal(measured.ingested, 1024);
  const duplicate = await request("/ingest/observe/v1/stats/batches", { events: ingested.slice(0, 64) }, { authorization: `Bearer ${auth.ingestToken}` });
  assert.equal(duplicate.status, 200); assert.equal(duplicate.body.duplicate, 64);
  const conflict = await request("/ingest/observe/v1/stats/batches", { events: [{ ...ingested[0], durationMs: ingested[0].durationMs + 1 }] }, { authorization: `Bearer ${auth.ingestToken}` });
  assert.equal(conflict.status, 409);
  const invalid = await request("/ingest/observe/v1/stats/batches", { events: [{}] }, { authorization: `Bearer ${auth.ingestToken}` });
  assert.equal(invalid.status, 400);
  const earliest = Math.min(...ingested.map(event => event.atMs)), latest = Math.max(...ingested.map(event => event.atMs));
  const stored = await request(`/api/observe/stats/external?from=${earliest}&to=${latest + 1}&limit=5000`);
  assert.equal(stored.status, 200);
  assert.ok(stored.body.events.length < 5000, "ingestion verification was truncated");
  const actual = new Map(stored.body.events.map(row => [row.event.eventId, row.event]));
  for (const event of ingested) assert.deepEqual(actual.get(event.eventId), event, "acknowledged ingestion changed");
  const windows = await verify();
  const row = { ...measured, exact: true, windows, outcomes: { duplicate: duplicate.status, conflict: conflict.status, invalid: invalid.status }, producer: producer?.stats(), receiver: bridge?.counters() };
  records.push(row); writeFileSync(join(root, "server-results.json"), JSON.stringify({ records }) + "\n", { mode: 0o600 });
  return row;
}
async function closeServer(server) { if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); } }
async function shutdown() {
  stopping = true;
  runtimeAbort.abort();
  await currentAction;
  if (ingestion) { ingestion.stopping = true; await ingestion.done; ingestion = undefined; }
  await closeServer(control);
  await closeServer(capture); await closeServer(bridge?.server); await producer?.shutdown();
  for (const owner of [...children].reverse()) await stop(owner);
  for (const [name, descriptor] of Object.entries(descriptors)) writeFileSync(join(state, `${name}.jsonc`), JSON.stringify(descriptor), { mode: 0o600 });
}
let signal, wake;
const interrupted = new Promise(done => { wake = done; });
for (const name of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) process.once(name, () => { signal = name; stopping = true; wake(); });
try {
  startEngine();
  await ready("http://127.0.0.1:44794/namespaces", engine, { authorization: `Bearer ${auth.engineToken}` });
  capture = createServer(async (request, response) => {
    try {
      let bytes = 0; const chunks = [];
      for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 1048576); chunks.push(chunk); }
      assert.ok(typeof request.headers.authorization === "string" && constantTimeEqual(request.headers.authorization, `Bearer ${otlpToken}`));
      const raw = Buffer.concat(chunks);
      if (variant === "collector-failure") { exportFailures++; response.writeHead(503).end(); return; }
      if (bridge) {
        const forwarded = await fetch("http://127.0.0.1:8792/v1/traces", { method: "POST", headers: { authorization: `Bearer ${otlpToken}`, "content-type": "application/json" }, body: raw, signal: AbortSignal.timeout(5000) });
        response.writeHead(forwarded.status, { "content-type": "application/json" }).end(await forwarded.text()); return;
      }
      const body = JSON.parse(raw);
      for (const resource of body.resourceSpans ?? []) for (const scope of resource.scopeSpans ?? []) for (const span of scope.spans ?? []) {
        const attrs = Object.fromEntries((span.attributes ?? []).map(attr => [attr.key, attr.value.stringValue]));
        const name = attrs["rivet.actor.name"], key = attrs["rivet.actor.key"];
        const role = /^installation-[a-f0-9]{8}$/u.test(name) ? "installation" : /^observation-store-[a-f0-9]{8}$/u.test(name) ? "observation" : null;
        if (role && !selectors.has(role) && /^[a-f0-9]{64}$/u.test(key)) selectors.set(role, { role, name, key });
      }
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    } catch { response.writeHead(400).end(); }
  });
  capture.requestTimeout = 5000; capture.maxConnections = 8;
  await new Promise(done => capture.listen(8791, "127.0.0.1", done));
  let busy = false;
  control = createServer((incoming, response) => {
    const credential = incoming.headers["stats-gateway-secret"];
    if (typeof credential !== "string" || !constantTimeEqual(credential, auth.secret)) { response.writeHead(401).end(); return; }
    if (incoming.url === "/stop") { stopping = true; runtimeAbort.abort(); response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ stopped: true })); wake(); return; }
    if (busy) { response.writeHead(409).end(); return; }
    busy = true;
    currentAction = (async () => {
      const url = new URL(incoming.url, "http://127.0.0.1");
      let result;
      if (url.pathname === "/start") result = await application(url.searchParams.get("variant"), Number(url.searchParams.get("round")));
      else if (url.pathname === "/begin") { await begin(); result = { started: true }; }
      else if (url.pathname === "/end") result = await finish();
      else if (url.pathname === "/engine/stop" || url.pathname === "/engine/start") {
        assert.ok(app && variant === "disabled" && !before && !ingestion && !values["cpu-profile"], "Engine recovery requires an idle uninstrumented private application");
        if (url.pathname === "/engine/stop") { await stop(engine); result = { stopped: true, status: engine.status }; }
        else { startEngine(); await ready("http://127.0.0.1:44794/namespaces", engine, { authorization: `Bearer ${auth.engineToken}` }); result = { started: true, pid: engine.child.pid }; }
      }
      else if (url.pathname === "/verify-summary") {
        const started = performance.now();
        let response;
        try { response = await fetch(`http://127.0.0.1:8787/api/observe/stats/external/telemetry/summary?from=${proof.fromMs}&to=${proof.toMs}`, { headers, signal: AbortSignal.any([runtimeAbort.signal, AbortSignal.timeout(1500)]) }); }
        catch (error) { if (stopping || !["TypeError", "TimeoutError", "AbortError"].includes(error.name)) throw error; result = { ready: false, error: error.name }; }
        if (response && [502, 503, 504].includes(response.status)) { await response.body?.cancel(); result = { ready: false, status: response.status }; }
        else if (response) {
          assert.equal(response.status, 200); const summary = await response.json(); assert.deepEqual(summary, reference(events, proof.fromMs, proof.toMs));
          result = { ready: true, exact: true, events: summary.totals.events, sha256: hash(canonical(summary)), ms: performance.now() - started, appPid: app.child.pid, appProcesses: [...cpu(app)].map(([pid, value]) => ({ pid, start: value.start })).sort((a, b) => a.pid - b.pid) };
        }
      }
      else if (url.pathname === "/snapshot") {
        assert.ok(app && variant === "disabled" && !before && !ingestion && !values["cpu-profile"]);
        result = {};
        for (const [role, name] of [["observation", "observe:stats"], ["installation", "installation"]]) {
          result[role] = await captureObjectSnapshot({ request, restore: async path => {
            const restored = await fetch(`http://127.0.0.1:8787${path}`, { method: "POST", headers, body: JSON.stringify({ fenced: false }), signal: AbortSignal.timeout(30000) });
            assert.equal(restored.status, 200, "private snapshot fence cleanup failed");
            assert.equal((await restored.json()).state, "open");
          } }, name);
        }
      }
      else if (url.pathname === "/validate") {
        let bytes = 0; const chunks = [];
        for await (const chunk of incoming) { bytes += chunk.length; assert.ok(bytes <= 1048576); chunks.push(chunk); }
        const samples = JSON.parse(Buffer.concat(chunks));
        assert.ok(Array.isArray(samples) && samples.length <= 10000);
        const expected = new Map();
        for (const sample of samples.filter(sample => !sample.cached)) {
          assert.ok(Number.isSafeInteger(sample.fromMs) && Number.isSafeInteger(sample.toMs) && sample.fromMs < sample.toMs && sample.toMs === proof.toMs);
          const key = `${sample.fromMs}:${sample.toMs}`;
          if (!expected.has(key)) expected.set(key, hash(canonical(reference(events, sample.fromMs, sample.toMs))));
          assert.equal(sample.sha256, expected.get(key), "browser response differs from independent corpus reference");
        }
        result = { exact: true, checked: samples.filter(sample => !sample.cached).length };
      }
      else throw new Error("unknown study action");
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    })().catch(error => { writeFileSync(join(root, "server-error.txt"), inspect(error, { depth: 5 }), { mode: 0o600 }); response.writeHead(500).end(JSON.stringify({ error: error.name, message: "study failed; protected diagnostic retained" })); wake(); }).finally(() => { busy = false; });
  });
  await new Promise(done => control.listen(8790, "0.0.0.0", done));
  console.log(JSON.stringify({ ready: true, engineSha256: values["engine-sha256"], events: proof.events }));
  await Promise.race([interrupted, engineFailure]);
} finally { await shutdown(); }
if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); }
