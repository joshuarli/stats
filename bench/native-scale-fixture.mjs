import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { root: { type: "string" }, mode: { type: "string", default: "prepare" }, image: { type: "string" }, listen: { type: "string", default: "127.0.0.1" }, resume: { type: "boolean", default: false }, baseline: { type: "string" }, candidate: { type: "string" }, "bundle-root": { type: "string", default: "/app" }, "runtime-auth-file": { type: "string" }, "import-delay-ms": { type: "string", default: "0" } } });
assert.ok(values.root && ["prepare", "serve", "ingest-cost"].includes(values.mode));
assert.ok(["127.0.0.1", "0.0.0.0"].includes(values.listen));
assert.equal(process.platform, "linux", "run inside the isolated production image");
if (values.mode === "prepare") assert.match(values.image ?? "", /^stats:[a-f0-9]{12}$/u, "preparation requires the actual container image reference");
const root = resolve(values.root), state = join(root, "native-scale-state");
const bundleRoot = resolve(values["bundle-root"]), importDelayMs = Number(values["import-delay-ms"]);
assert.ok(Number.isSafeInteger(importDelayMs) && importDelayMs >= 0 && importDelayMs <= 5000);
const externalEndpoint = process.env.RIVET_ENDPOINT;
if (externalEndpoint) {
  assert.ok(["serve", "prepare"].includes(values.mode));
  const endpoint = new URL(externalEndpoint);
  assert.equal(endpoint.hostname, "127.0.0.1"); assert.equal(endpoint.protocol, "http:");
  assert.ok(!endpoint.username && !endpoint.password && /^[a-z][a-z0-9-]{0,63}$/u.test(process.env.RIVET_NAMESPACE ?? ""));
  if (values.mode === "prepare") {
    assert.match(process.env.RIVET_NAMESPACE, /^stats-scale-/u, "external preparation requires a dedicated fixture namespace");
    assert.ok(Number.isSafeInteger(Number(process.env.RIVET_NODE_VERSION)) && Number(process.env.RIVET_NODE_VERSION) > 0, "external preparation requires an explicit node version");
  }
}
assert.ok(values["runtime-auth-file"] === undefined || externalEndpoint && values.mode === "prepare" && !values.resume);
const authPath = join(state, "fixture-auth.json"), proofPath = join(root, "native-scale-preparation.json");
const planPath = join(state, "import-plan.json");
const pause = ms => new Promise(done => setTimeout(done, ms));
const sha256 = body => createHash("sha256").update(body).digest("hex");
function readFixtureAuth(file) {
  try {
    const credentials = JSON.parse(readFileSync(file, "utf8"));
    assert.ok(credentials && typeof credentials === "object" && typeof credentials.secret === "string" && /^[A-Za-z0-9_-]{32,128}$/u.test(credentials.secret));
    return credentials;
  } catch { throw new Error("could not read protected fixture credentials"); }
}
mkdirSync(state, { recursive: true, mode: 0o700 });
let auth, active, stopping = false;
if ((values.mode === "prepare" && !values.resume) || (values.mode === "ingest-cost" && !existsSync(authPath))) {
  assert.ok(!existsSync(authPath), "preparation requires fresh disposable state");
  if (externalEndpoint) {
    assert.ok(values["runtime-auth-file"], "external preparation requires protected fixture runtime credentials");
    const source = readFixtureAuth(values["runtime-auth-file"]);
    assert.ok(typeof source.engineToken === "string" && source.engineToken.length > 0);
    auth = { secret: source.secret, engineToken: source.engineToken };
  } else auth = { secret: randomBytes(32).toString("hex") };
  writeFileSync(authPath, JSON.stringify(auth), { flag: "wx", mode: 0o600 });
  for (const name of ["stats", "observe"]) {
    const descriptor = JSON.parse(readFileSync(join(bundleRoot, `${name}.jsonc`), "utf8"));
    descriptor.main = join(bundleRoot, descriptor.main);
    if (descriptor.assets) descriptor.assets.directory = join(bundleRoot, descriptor.assets.directory);
    delete descriptor.vars.APPLICATION_EVENTS_RELEASE;
    delete descriptor.triggers;
    descriptor.vars.GATEWAY_SECRET = auth.secret;
    descriptor.vars.ENVIRONMENT = "development";
    writeFileSync(join(state, `${name}.jsonc`), JSON.stringify(descriptor), { flag: "wx", mode: 0o600 });
  }
} else auth = readFixtureAuth(authPath);
if (values.mode === "ingest-cost") {
  assert.ok(values.baseline && values.candidate);
  const path = join(state, "observe.jsonc"), descriptor = JSON.parse(readFileSync(path, "utf8"));
  descriptor.main = join(state, "observe-cost.js");
  writeFileSync(descriptor.main, readFileSync(values.baseline));
  writeFileSync(path, JSON.stringify(descriptor), { mode: 0o600 });
}
const headers = { "Stats-Gateway-Secret": auth.secret, "Stats-Tailnet-Identity": "user:benchmark@example.invalid", "content-type": "application/json" };
if (externalEndpoint) {
  assert.ok(typeof auth.engineToken === "string" && auth.engineToken.length > 0, "external fixture Engine credentials must be in the protected auth file");
}
async function start() {
  assert.ok(existsSync("/.dockerenv"), "fixture runtime management requires an isolated Docker container");
  const identities = join(state, ".open-orange", "rivetkit");
  for (const identity of !externalEndpoint && existsSync(identities) ? readdirSync(identities) : []) {
    const stampPath = join(identities, identity, ".rivetkit", "var", "engine", "runtime.json");
    if (!existsSync(stampPath)) continue;
    const stamp = JSON.parse(readFileSync(stampPath, "utf8"));
    assert.ok(Number.isSafeInteger(stamp.pid) && stamp.pid > 0);
    let comm, status;
    try { comm = readFileSync(`/proc/${stamp.pid}/comm`, "utf8").trim(); status = readFileSync(`/proc/${stamp.pid}/status`, "utf8"); } catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error; }
    if (comm !== "rivet-engine" || /^State:\s+[ZX]/mu.test(status ?? "")) unlinkSync(stampPath);
  }
  const started = performance.now();
  const child = spawn(process.execPath, ["/orange/node_modules/open-orange/dist/bin.js", externalEndpoint ? "serve" : "dev", ...(externalEndpoint ? [] : ["--json"]), "--ip", values.listen, "--port", "8787", "--config", join(state, "stats.jsonc"), "--config", join(state, "observe.jsonc")], { cwd: state, detached: true, env: { ...process.env, ...(externalEndpoint ? { RIVET_TOKEN: auth.engineToken } : {}), OTEL_SDK_DISABLED: "true", RIVET_LOG_LEVEL: process.env.RIVET_LOG_LEVEL ?? "error", WRANGLER_LOG_PATH: join(state, "wrangler.log") }, stdio: ["ignore", "pipe", "pipe"] });
  const owner = { child, origin: null, failed: false, stderr: "", stdout: "" }; active = owner;
  let buffer = "";
  child.stdout.on("data", chunk => {
    owner.stdout = (owner.stdout + chunk).slice(-1048576);
    buffer += chunk;
    if (buffer.length >= 1048576) { buffer = ""; owner.failed = true; return; }
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (externalEndpoint) {
        const ready = /orange serve listening on (http:\/\/(?:127\.0\.0\.1|0\.0\.0\.0):\d+)/u.exec(line);
        if (ready) owner.origin = ready[1].replace("0.0.0.0", "127.0.0.1");
      }
      try { const event = JSON.parse(line); if (event.type === "ready") owner.origin = event.url.replace("0.0.0.0", "127.0.0.1").replace(/\/$/u, ""); } catch {}
    }
  });
  child.stderr.on("data", chunk => { owner.stderr = (owner.stderr + chunk).slice(-16384); });
  child.once("error", () => { owner.failed = true; });
  child.once("exit", () => { owner.failed = true; });
  const deadline = Date.now() + 120000;
  while (!owner.origin && !owner.failed && !stopping && Date.now() < deadline) await pause(50);
  if (!owner.origin || owner.failed || stopping) { writeFileSync(join(state, "startup-error.log"), JSON.stringify({ stdout: owner.stdout, stderr: owner.stderr }), { mode: 0o600 }); throw new Error("isolated runtime did not become ready; private startup log retained"); }
  assert.equal(new URL(owner.origin).hostname, "127.0.0.1");
  let actorReady = false;
  while (!actorReady && !owner.failed && !stopping && Date.now() < deadline) {
    const result = await request("/api/v1/hosts");
    if (result.status === 200) actorReady = true;
    else { assert.ok([502, 503, 504].includes(result.status), `unexpected fixture readiness HTTP ${result.status}`); await pause(100); }
  }
  assert.ok(actorReady, "fixture Installation actor did not become ready");
  return performance.now() - started;
}
async function stop() {
  if (!active) return;
  const owner = active; active = undefined;
  const signal = name => { try { process.kill(-owner.child.pid, name); } catch (error) { if (error.code !== "ESRCH") throw error; } };
  owner.child.kill("SIGTERM");
  const deadline = Date.now() + 20000;
  while (owner.child.exitCode === null && owner.child.signalCode === null && Date.now() < deadline) await pause(50);
  signal("SIGKILL");
}
for (const name of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) process.once(name, () => { stopping = true; void stop().finally(() => process.exit(128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGQUIT: 3 }[name]))); });
async function request(path, init = {}) {
  assert.ok(active?.origin && !stopping);
  const response = await fetch(active.origin + path, { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(120000) });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch {
    writeFileSync(join(state, "failed-response.txt"), text.slice(0, 65536), { mode: 0o600 });
    throw new Error(`${init.method ?? "GET"} ${new URL(path, active.origin).pathname} returned HTTP ${response.status} without JSON`);
  }
  return { status: response.status, body, timing: response.headers.get("server-timing") };
}
const post = (path, body) => request(path, { method: "POST", body: JSON.stringify(body) });
const object = "/api/v1/admin/objects/observe:stats";
function reference(events, fromMs, toMs) {
  const stepMs = Math.max(1000, Math.ceil((toMs - fromMs) / 120000) * 1000);
  const buckets = new Map(), operations = new Map();
  const empty = atMs => ({ events: 0, failed: 0, cancelled: 0, requests: 0, requestDurationMsSum: 0, requestDurationMsMax: 0, status2xx: 0, status3xx: 0, status4xx: 0, status5xx: 0, durationMsSum: 0, durationMsMax: 0, firstAtMs: atMs, lastAtMs: atMs });
  const add = (total, event) => {
    const status = event.work.http_status;
    const http = Number.isInteger(status) && status >= 100 && status <= 599;
    total.events++;
    total.failed += Number(event.outcome !== "ok"); total.cancelled += Number(event.outcome === "cancelled");
    total.requests += Number(http);
    total.requestDurationMsSum += http ? event.durationMs : 0;
    total.requestDurationMsMax = Math.max(total.requestDurationMsMax, http ? event.durationMs : 0);
    for (const code of [2, 3, 4, 5]) total[`status${code}xx`] += Number(http && Math.floor(status / 100) === code);
    total.durationMsSum += event.durationMs; total.durationMsMax = Math.max(total.durationMsMax, event.durationMs);
    total.firstAtMs = Math.min(total.firstAtMs, event.atMs); total.lastAtMs = Math.max(total.lastAtMs, event.atMs);
  };
  let totals = null;
  for (const event of events) {
    if (event.atMs < fromMs || event.atMs >= toMs) continue;
    totals ??= empty(event.atMs); add(totals, event);
    const atMs = Math.floor((event.atMs - fromMs) / stepMs) * stepMs + fromMs;
    const bucket = buckets.get(atMs) ?? { ...empty(event.atMs), atMs }; add(bucket, event); buckets.set(atMs, bucket);
    const operation = operations.get(event.operation) ?? { ...empty(event.atMs), operation: event.operation }; add(operation, event); operations.set(event.operation, operation);
  }
  const ranked = [...operations.values()].sort((left, right) => right.events - left.events || (left.operation < right.operation ? -1 : left.operation > right.operation ? 1 : 0));
  return { provenance: "application", fromMs, toMs, stepMs, totals, openIssues: 0, buckets: [...buckets.values()].sort((left, right) => left.atMs - right.atMs), operations: ranked.slice(0, 20), moreOperations: ranked.length > 20 };
}
try {
  const readinessMs = [await start()];
  if (values.mode === "ingest-cost") {
    const hosts = await request("/api/v1/hosts"); assert.equal(hosts.status, 200);
    if (hosts.body.hosts.length === 0) assert.equal((await post("/api/v1/admin/hosts", { name: "write-cost-fixture" })).status, 201);
    const raw = readFileSync(join(root, "corpus.json"));
    assert.equal(sha256(raw), "4ef33788757e84e614b35dd2509a942987b7e5350d634bc327a4055d5dd3e006");
    const captured = JSON.parse(raw).events.slice(0, 512).map(row => row.event);
    assert.equal(captured.length, 512);
    const latest = Math.max(...captured.map(event => event.atMs)), shift = Date.now() - 60_000 - latest;
    const fromMs = Math.min(...captured.map(event => event.atMs)) + shift, toMs = latest + shift + 1;
    const results = [], failures = [];
    const sources = Object.fromEntries(["baseline", "candidate"].map(variant => [variant, sha256(readFileSync(values[variant]))]));
    const save = () => writeFileSync(join(root, "projection-ingest-cost.json"), JSON.stringify({ sourceSha256: sha256(raw), sources, workload: "eight durable 64-event batches per fresh actor, five alternating rounds, instrumentation disabled", results, failures }) + "\n", { mode: 0o600 });
    try {
      for (let round = 0; round < 5; round++) for (const variant of (round % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"])) {
        await stop();
        writeFileSync(join(state, "observe-cost.js"), readFileSync(values[variant]));
        await start();
        const hosts = await request("/api/v1/hosts"); assert.equal(hosts.status, 200);
        const service = `perf-${variant === "baseline" ? "b" : "c"}-${round}-${randomBytes(4).toString("hex")}`;
        const created = await post("/api/v1/admin/services", { name: service, hostIds: [hosts.body.hosts[0].hostId] }); assert.equal(created.status, 201);
        const healthPath = `/api/observe/${service}/health`;
        const before = await request(healthPath); assert.equal(before.status, 200);
        const input = captured.map((event, index) => ({ ...event, service, eventId: `ingest-proof-${index}`, atMs: event.atMs + shift }));
        const cpu = () => Number(/^usage_usec (\d+)/mu.exec(readFileSync("/sys/fs/cgroup/cpu.stat", "utf8"))[1]);
        const cpuBefore = cpu(), started = performance.now(), batchMs = [];
        let accepted = 0;
        const ingest = events => request(`/ingest/observe/v1/${service}/batches`, { method: "POST", headers: { authorization: `Bearer ${created.body.ingestToken}` }, body: JSON.stringify({ events }) });
        for (let offset = 0; offset < input.length; offset += 64) {
          const batch = input.slice(offset, offset + 64); assert.ok(Buffer.byteLength(JSON.stringify({ events: batch })) < 65536);
          const began = performance.now(), result = await ingest(batch);
          batchMs.push(performance.now() - began);
          assert.equal(result.status, 202); assert.equal(result.body.accepted, batch.length); accepted += result.body.accepted;
        }
        const wallMs = performance.now() - started, cpuUs = cpu() - cpuBefore;
        assert.equal(accepted, 512);
        const duplicate = await ingest(input.slice(0, 64)); assert.equal(duplicate.status, 200);
        assert.deepEqual(duplicate.body, { accepted: 0, duplicate: 64 });
        const conflict = await ingest([{ ...input[0], durationMs: input[0].durationMs + 1 }]); assert.equal(conflict.status, 409);
        const summary = await request(`/api/observe/${service}/external/telemetry/summary?from=${fromMs}&to=${toMs}`); assert.equal(summary.status, 200);
        const expected = reference(input, fromMs, toMs);
        for (const key of ["totals", "buckets", "operations"]) assert.deepEqual(summary.body[key], expected[key]);
        const after = await request(healthPath); assert.equal(after.status, 200);
        const record = { round, variant, accepted, duplicate: 64, conflict: 409, wallMs, cpuUs, batchMs, databaseBytesBefore: before.body.databaseBytes, databaseBytesAfter: after.body.databaseBytes };
        results.push(record); save(); console.log(JSON.stringify(record));
      }
    } catch (error) { failures.push({ name: error.name, message: error.message }); save(); throw error; }
  } else if (values.mode === "serve") {
    console.log(JSON.stringify({ ready: true, port: 8787, instrumentation: "disabled", state: externalEndpoint ? "orange serve with independently managed private Engine and disposable state" : "isolated embedded Engine and disposable application state" }));
    while (!stopping) { await pause(1000); assert.ok(active && !active.failed, "runtime exited"); }
  } else {
    const raw = readFileSync(join(root, "corpus-10x.json"));
    assert.equal(sha256(raw), "c4c682b2d8cbd62ad7e1a574378ad6b38207827d7feeb357599ad5ea13a85e64");
    const corpus = JSON.parse(raw);
    assert.equal(corpus.events.length, 203950);
    const previousPlan = values.resume ? JSON.parse(readFileSync(planPath, "utf8")) : null;
    const latest = previousPlan?.latest ?? Date.now() - 60000, shiftMs = latest - corpus.metadata.lastAtMs;
    const events = corpus.events.map(event => ({ ...event, atMs: event.atMs + shiftMs }));
    let manifest;
    if (previousPlan) manifest = previousPlan.manifest;
    else {
      const host = await post("/api/v1/admin/hosts", { name: "scale-fixture" }); assert.equal(host.status, 201);
      assert.ok(typeof host.body.token === "string" && typeof host.body.hostId === "string");
      const service = await post("/api/v1/admin/services", { name: "stats", hostIds: [host.body.hostId] }); assert.equal(service.status, 201);
      auth.hostId = host.body.hostId;
      auth.hostToken = host.body.token;
      auth.ingestToken = service.body.ingestToken;
      writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });
      assert.equal((await post(`${object}/maintenance`, { fenced: true })).status, 200);
      const exported = await request(`${object}/export/manifest`); assert.equal(exported.status, 200);
      manifest = exported.body;
      assert.ok(manifest.tables.every(table => table.rows === 0), "fixture object must be entirely empty");
    }
    const table = manifest.tables.find(table => table.name === "observe_external_events"); assert.ok(table);
    const receivedAtMs = previousPlan?.receivedAtMs ?? Date.now();
    const rows = events.map(event => {
      assert.equal(event.service, "stats");
      const fields = { service: event.service, event_id: event.eventId, received_at: receivedAtMs, event_at: event.atMs, provenance: "application", payload: JSON.stringify(event) };
      return table.columns.map(column => { assert.ok(Object.hasOwn(fields, column)); return fields[column]; });
    });
    assert.deepEqual(table.key, ["service", "event_id"]);
    const eventIdColumn = table.columns.indexOf("event_id");
    rows.sort((left, right) => left[eventIdColumn] < right[eventIdColumn] ? -1 : left[eventIdColumn] > right[eventIdColumn] ? 1 : 0);
    const digest = createHash("sha256");
    for (const row of rows) digest.update(JSON.stringify(row) + "\n");
    const tableSha256 = digest.digest("hex");
    if (previousPlan) { assert.equal(table.rows, rows.length); assert.equal(table.sha256, tableSha256); }
    else { table.rows = rows.length; table.sha256 = tableSha256; }
    manifest.alarmAtMs = null;
    if (!previousPlan) writeFileSync(planPath, JSON.stringify({ latest, receivedAtMs, manifest }), { flag: "wx", mode: 0o600 });
    const begun = await post(`${object}/import/begin`, manifest); assert.equal(begun.status, 200);
    const imported = begun.body.progress.find(item => item.table === table.name)?.rows;
    assert.ok(Number.isSafeInteger(imported) && imported >= 0 && imported <= rows.length);
    const lastAckPath = join(state, "last-acknowledged-import.json");
    const previousAcknowledgedRows = existsSync(lastAckPath) ? JSON.parse(readFileSync(lastAckPath, "utf8")).rows : null;
    console.log(JSON.stringify({ recoveredImportRows: imported, previousAcknowledgedRows }));
    if (previousAcknowledgedRows !== null) assert.ok(imported >= previousAcknowledgedRows, "native restart lost acknowledged imported rows");
    for (let offset = imported; offset < rows.length; offset += 500) {
      const page = rows.slice(offset, offset + 500);
      const result = await post(`${object}/import/rows`, { table: table.name, offset, rows: page });
      assert.equal(result.status, 200); assert.equal(result.body.rows, offset + page.length);
      writeFileSync(join(state, "last-acknowledged-import.json"), JSON.stringify({ rows: result.body.rows }), { mode: 0o600 });
      if (offset % 10000 === 0) console.log(JSON.stringify({ preparing: result.body.rows, total: rows.length, containerMemoryBytes: Number(readFileSync("/sys/fs/cgroup/memory.current", "utf8")) }));
      if (importDelayMs > 0 && offset + page.length < rows.length) await pause(importDelayMs);
    }
    const finished = await post(`${object}/import/finish`, {}); assert.equal(finished.status, 200);
    const fromMs = latest - 6 * 86400000, toMs = latest + 1;
    const summaryPath = `/api/observe/stats/external/telemetry/summary?from=${fromMs}&to=${toMs}`;
    const summary = await request(summaryPath); assert.equal(summary.status, 200); assert.equal(summary.body.totals.events, events.length);
    const referenceWindows = [];
    for (const hours of [1, 6, 24, 168]) {
      const queryFromMs = toMs - hours * 3600000;
      const result = await request(`/api/observe/stats/external/telemetry/summary?from=${queryFromMs}&to=${toMs}`);
      assert.equal(result.status, 200);
      assert.equal(result.body.toMs, toMs);
      assert.ok(result.body.fromMs >= queryFromMs);
      if (hours < 168) assert.equal(result.body.fromMs, queryFromMs);
      assert.deepEqual(result.body, reference(events, result.body.fromMs, result.body.toMs));
      referenceWindows.push({ hours, events: result.body.totals.events, fromMs: result.body.fromMs, toMs, completeReferenceEqual: true });
    }
    const duplicate = await request("/ingest/observe/v1/stats/batches", { method: "POST", headers: { authorization: `Bearer ${auth.ingestToken}` }, body: JSON.stringify({ events: events.slice(0, 64) }) });
    assert.equal(duplicate.status, 200); assert.equal(duplicate.body.accepted, 0); assert.equal(duplicate.body.duplicate, 64);
    const changed = { ...events[0], durationMs: events[0].durationMs + 1 };
    const conflict = await request("/ingest/observe/v1/stats/batches", { method: "POST", headers: { authorization: `Bearer ${auth.ingestToken}` }, body: JSON.stringify({ events: [changed] }) });
    assert.equal(conflict.status, 409);
    await stop(); readinessMs.push(await start());
    const recovered = await request(summaryPath); assert.equal(recovered.status, 200);
    assert.deepEqual(recovered.body, summary.body);
    const runtimeSources = Object.fromEntries(["stats", "observe"].map(name => [name, sha256(readFileSync(JSON.parse(readFileSync(join(state, `${name}.jsonc`), "utf8")).main))]));
    const proof = { sourceImage: values.image, runtimeSources, namespace: process.env.RIVET_NAMESPACE ?? "embedded-default", nodeVersion: externalEndpoint ? Number(process.env.RIVET_NODE_VERSION) : null, runtimeMode: externalEndpoint ? "serve" : "dev", importDelayMs, sourceSha256: corpus.metadata.sourceSha256, fixtureSha256: sha256(raw), events: events.length, preparation: "integrity-verified native snapshot import, not ingest throughput evidence", recoveredImportRows: imported, previousAcknowledgedRows, shiftMs, firstAtMs: corpus.metadata.firstAtMs + shiftMs, lastAtMs: latest, fromMs, toMs, receivedAtMs, tableSha256: table.sha256, referenceWindows, duplicate: duplicate.body.duplicate, changedDuplicateStatus: conflict.status, restoredSummaryEqual: true, readinessMs, summaryTiming: summary.timing, recoveredTiming: recovered.timing };
    writeFileSync(proofPath, JSON.stringify(proof) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify(proof));
  }
} catch (error) {
  if (active) {
    writeFileSync(join(state, "runtime-error.stdout.log"), active.stdout, { mode: 0o600 });
    writeFileSync(join(state, "runtime-error.stderr.log"), active.stderr, { mode: 0o600 });
    writeFileSync(join(state, "failure-resources.json"), JSON.stringify({ memory: readFileSync("/sys/fs/cgroup/memory.current", "utf8").trim(), memoryEvents: readFileSync("/sys/fs/cgroup/memory.events", "utf8"), cpu: readFileSync("/sys/fs/cgroup/cpu.stat", "utf8") }), { mode: 0o600 });
  }
  throw error;
} finally { await stop(); }
