import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { root: { type: "string" }, mode: { type: "string", default: "prepare" }, listen: { type: "string", default: "127.0.0.1" }, resume: { type: "boolean", default: false } } });
assert.ok(values.root && ["prepare", "serve"].includes(values.mode));
assert.ok(["127.0.0.1", "0.0.0.0"].includes(values.listen));
assert.equal(process.platform, "linux", "run inside the isolated production image");
const root = resolve(values.root), state = join(root, "native-scale-state");
const authPath = join(state, "fixture-auth.json"), proofPath = join(root, "native-scale-preparation.json");
const planPath = join(state, "import-plan.json");
const pause = ms => new Promise(done => setTimeout(done, ms));
const sha256 = body => createHash("sha256").update(body).digest("hex");
mkdirSync(state, { recursive: true, mode: 0o700 });
let auth, active, stopping = false;
if (values.mode === "prepare" && !values.resume) {
  assert.ok(!existsSync(authPath), "preparation requires fresh disposable state");
  auth = { secret: randomBytes(32).toString("hex") };
  writeFileSync(authPath, JSON.stringify(auth), { flag: "wx", mode: 0o600 });
  for (const name of ["stats", "observe"]) {
    const descriptor = JSON.parse(readFileSync(`/app/${name}.jsonc`, "utf8"));
    descriptor.main = join("/app", descriptor.main);
    if (descriptor.assets) descriptor.assets.directory = join("/app", descriptor.assets.directory);
    delete descriptor.vars.APPLICATION_EVENTS_RELEASE;
    delete descriptor.triggers;
    descriptor.vars.GATEWAY_SECRET = auth.secret;
    descriptor.vars.ENVIRONMENT = "development";
    writeFileSync(join(state, `${name}.jsonc`), JSON.stringify(descriptor), { flag: "wx", mode: 0o600 });
  }
} else auth = JSON.parse(readFileSync(authPath, "utf8"));
const headers = { "Stats-Gateway-Secret": auth.secret, "Stats-Tailnet-Identity": "user:benchmark@example.invalid", "content-type": "application/json" };
async function start() {
  assert.ok(existsSync("/.dockerenv"), "fixture runtime management requires an isolated Docker container");
  const identities = join(state, ".open-orange", "rivetkit");
  for (const identity of existsSync(identities) ? readdirSync(identities) : []) {
    const stampPath = join(identities, identity, ".rivetkit", "var", "engine", "runtime.json");
    if (!existsSync(stampPath)) continue;
    const stamp = JSON.parse(readFileSync(stampPath, "utf8"));
    assert.ok(Number.isSafeInteger(stamp.pid) && stamp.pid > 0);
    let comm, status;
    try { comm = readFileSync(`/proc/${stamp.pid}/comm`, "utf8").trim(); status = readFileSync(`/proc/${stamp.pid}/status`, "utf8"); } catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error; }
    if (comm !== "rivet-engine" || /^State:\s+[ZX]/mu.test(status ?? "")) unlinkSync(stampPath);
  }
  const started = performance.now();
  const child = spawn(process.execPath, ["/orange/node_modules/open-orange/dist/bin.js", "dev", "--json", "--ip", values.listen, "--port", "8787", "--config", join(state, "stats.jsonc"), "--config", join(state, "observe.jsonc")], { cwd: state, detached: true, env: { ...process.env, OTEL_SDK_DISABLED: "true", RIVET_LOG_LEVEL: process.env.RIVET_LOG_LEVEL ?? "error" }, stdio: ["ignore", "pipe", "pipe"] });
  const owner = { child, origin: null, failed: false, stderr: "", stdout: "" }; active = owner;
  let buffer = "";
  child.stdout.on("data", chunk => {
    owner.stdout = (owner.stdout + chunk).slice(-1048576);
    buffer += chunk;
    if (buffer.length >= 1048576) { buffer = ""; owner.failed = true; return; }
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { const event = JSON.parse(line); if (event.type === "ready") owner.origin = event.url.replace("0.0.0.0", "127.0.0.1").replace(/\/$/u, ""); } catch {}
    }
  });
  child.stderr.on("data", chunk => { owner.stderr = (owner.stderr + chunk).slice(-16384); });
  child.once("error", () => { owner.failed = true; });
  child.once("exit", () => { owner.failed = true; });
  const deadline = Date.now() + 120000;
  while (!owner.origin && !owner.failed && !stopping && Date.now() < deadline) await pause(50);
  if (!owner.origin || owner.failed || stopping) { writeFileSync(join(state, "startup-error.log"), owner.stderr, { mode: 0o600 }); throw new Error("isolated runtime did not become ready; private startup log retained"); }
  assert.equal(new URL(owner.origin).hostname, "127.0.0.1");
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
  if (values.mode === "serve") {
    console.log(JSON.stringify({ ready: true, port: 8787, instrumentation: "disabled", state: "isolated embedded Engine and disposable application state" }));
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
      const service = await post("/api/v1/admin/services", { name: "stats", hostIds: [host.body.hostId] }); assert.equal(service.status, 201);
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
    const proof = { sourceImage: "stats:1ea3e6af2dc3", sourceSha256: corpus.metadata.sourceSha256, fixtureSha256: sha256(raw), events: events.length, preparation: "integrity-verified native snapshot import, not ingest throughput evidence", recoveredImportRows: imported, previousAcknowledgedRows, shiftMs, firstAtMs: corpus.metadata.firstAtMs + shiftMs, lastAtMs: latest, fromMs, toMs, receivedAtMs, tableSha256: table.sha256, referenceWindows, duplicate: duplicate.body.duplicate, changedDuplicateStatus: conflict.status, restoredSummaryEqual: true, readinessMs, summaryTiming: summary.timing, recoveredTiming: recovered.timing };
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
