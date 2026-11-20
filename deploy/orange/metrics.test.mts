import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ORANGE_ROOT, generate } from "./generate.mts";
import { freePort } from "./session.mts";
import { startStack, type Stack } from "./canary/stack.mts";
import { prepare, runWorkload } from "./canary/workload.mts";
import { recover, monitorResources, source, waitCheckpoint, writeBundle } from "./canary/evidence.mts";

const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const bin = (root: string) => join(root, "node_modules/open-orange/dist/bin.js");

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  await exited;
  clearTimeout(timer);
}

async function metrics(root: string, directory: string) {
  let collector: ChildProcess | undefined;
  mkdirSync(directory, { recursive: true });
  const [guard, peer, engineMetrics, port] = await Promise.all(Array.from({ length: 4 }, () => freePort()));
  let base: number;
  for (;;) {
    base = await freePort();
    if (base === 65535) continue;
    const probe = createServer();
    if (await new Promise<boolean>(resolve => { probe.once("error", () => resolve(false)); probe.listen(base + 1, "127.0.0.1", () => probe.close(() => resolve(true))); })) break;
  }
  const engineDir = join(directory, "engine");
  mkdirSync(join(engineDir, "log"), { recursive: true });
  const config = join(engineDir, "config.json");
  writeFileSync(config, JSON.stringify({
    topology: { datacenter_label: 1, datacenters: { default: {
      datacenter_label: 1, is_leader: true,
      peer_url: `http://127.0.0.1:${peer}/`, public_url: `http://127.0.0.1:${guard}/`
    } } }
  }));
  const requireFromClosure = createRequire(join(root, "package.json"));
  const requireFromRivet = createRequire(requireFromClosure.resolve("rivetkit"));
  const { getEnginePath } = requireFromRivet("@rivetkit/engine-cli") as { getEnginePath(): string };
  let output = "";
  const engine = spawn(getEnginePath(), ["--config", config], {
    cwd: engineDir,
    env: {
      ...process.env,
      RIVET__API_PEER__HOST: "127.0.0.1", RIVET__API_PEER__PORT: String(peer),
      RIVET__AUTH__ADMIN_TOKEN: "canary", RIVET__GUARD__HOST: "127.0.0.1",
      RIVET__GUARD__PORT: String(guard), RIVET__METRICS__HOST: "127.0.0.1",
      RIVET__METRICS__PORT: String(engineMetrics), RIVET__PEGBOARD__NODE_LOST_THRESHOLD: "7000",
      RIVET__OBJECT_STORAGE__PRIMARY__FILE_SYSTEM__PATH: join(engineDir, "objects"),
      RIVET__STORAGE__AUTO_PROVISION_PARTITIONS: "1", RIVET__STORAGE__BALANCING__ENABLED: "false",
      RIVET__STORAGE__COLD_STORE__DISK_CACHE_BYTES: "0", RIVET__STORAGE__LOG_DIRECTORY: join(engineDir, "log"),
      RIVET__STORAGE__LOG_SHARD__MAX_DISK_BYTES: String(1024 * 1024 * 1024)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  engine.stdout!.on("data", c => { output += c; }); engine.stderr!.on("data", c => { output += c; });
  let serve: ChildProcess | undefined;
  try {
    const deadline = Date.now() + 60_000;
    while (true) {
      assert.equal(engine.exitCode, null, output);
      const response = await fetch(`http://127.0.0.1:${guard}/actors/names?namespace=default`, { headers: { authorization: "Bearer canary" }, signal: AbortSignal.timeout(2000) }).catch(() => undefined);
      if (response?.status === 200) break;
      assert.ok(Date.now() < deadline, output);
      await delay(250);
    }
    const state = join(directory, "state");
    generate(state, { kind: "dev", release: "metrics", gatewaySecret: "metrics-secret", nowMs: null });
    const descriptor = JSON.parse(readFileSync(join(state, "stats.jsonc"), "utf8"));
    const token = `nft_${"a".repeat(43)}`;
    descriptor.vars.INFRA_METRICS_TOKEN_SHA256 = createHash("sha256").update(token).digest("hex");
    writeFileSync(join(state, "stats.jsonc"), JSON.stringify(descriptor));
    const origin = `http://127.0.0.1:${port}`;
    const release = join(directory, "release.json");
    const secret = join(directory, "token");
    const configFile = join(directory, "collector.json");
    writeFileSync(release, JSON.stringify({ runtime: "rt-0123456789ab", app: "abcdef012345" }));
    writeFileSync(secret, token);
    writeFileSync(configFile, JSON.stringify({ name: "infra", releaseFile: release, tokenFile: secret, endpoint: `${origin}/ingest/metrics/v1/batches`, targets: [
      { id: "engine:local", url: `http://127.0.0.1:${engineMetrics}/metrics` },
      { id: "worker:stats:0", url: `http://127.0.0.1:${base}/metrics` },
      { id: "worker:stats-observe:1", url: `http://127.0.0.1:${base + 1}/metrics` }
    ] }));
    serve = spawn(process.execPath, [
      bin(root), "serve", "--config", join(state, "stats.jsonc"), "--config", join(state, "observe.jsonc")
    ], {
      cwd: state,
      env: { ...process.env, PORT: String(port), RIVET_ENDPOINT: `http://default:canary@127.0.0.1:${guard}`, RIVETKIT_METRICS_PORT: String(base) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    serve.stdout!.on("data", c => { output += c; }); serve.stderr!.on("data", c => { output += c; });
    while (!output.includes("orange serve listening on")) { assert.equal(serve.exitCode, null, output); assert.ok(Date.now() < deadline, output); await delay(200); }
    collector = spawn(process.execPath, [resolve(".work/tmp/infra-collector/main.mjs")], { env: { ...process.env, INFRA_COLLECTOR_CONFIG: configFile }, stdio: ["ignore", "pipe", "pipe"] });
    collector.stdout!.on("data", c => { output += c; }); collector.stderr!.on("data", c => { output += c; });
    await delay(2000);
    const found = [];
    for (const [index, worker] of ["stats", "stats-observe"].entries()) {
      const response = await fetch(`http://127.0.0.1:${base + index}/metrics`);
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.ok(body.includes(`openorange_worker_info{worker="${worker}",index="${index}"} 1`), body);
      assert.match(body, /^openorange_worker_start_time_seconds [\d.]+$/m);
      found.push(body.match(/^openorange_worker_(?:info|start_time_seconds).*$/gm));
    }
    const headers = { "Stats-Gateway-Secret": "metrics-secret", "Stats-Tailnet-Identity": "user:metrics@example.com" };
    const query = `${origin}/api/observe/stats-infra/metrics/sources?from=${Date.now() - 60000}&to=${Date.now() + 60000}&release=runtime`;
    let sources: any[] = [];
    const until = Date.now() + 45000;
    while (Date.now() < until) {
      const response = await fetch(query, { headers });
      if (response.ok) sources = (await response.json() as { sources: any[] }).sources;
      else console.log("sources response", response.status, await response.text());
      if (sources.length === 3 && sources.every(source => source.detail.lastOkAtMs !== null)) break;
      await delay(2500);
    }
    assert.equal(sources.length, 3, output);
    assert.ok(sources.every(source => source.detail.lastOkAtMs !== null), `${JSON.stringify(sources)}\n${output}`);

    const before = await (await fetch(`${origin}/api/v1/admin/objects`, { headers })).json();
    assert.deepEqual(before, { objects: [
      "installation", "observe:discover", "observe:discover-preview", "observe:nanoshop-fieldhouse",
      "observe:nanoshop-storied", "observe:nanoshop-tidewater", "observe:stats", "observe:usr-memories"
    ] });
    const manifests = async () => {
      const result: unknown[] = [];
      for (const object of ["installation", "observe:stats"]) {
        const prefix = `${origin}/api/v1/admin/objects/${object}`;
        const fence = (fenced: boolean) => fetch(`${prefix}/maintenance`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ fenced }) });
        assert.equal((await fence(true)).status, 200);
        const response = await fetch(`${prefix}/export/manifest`, { headers });
        assert.equal(response.status, 200);
        const manifest = await response.json() as { schema: { sha256: string }; tables: { name: string; sql: string }[] };
        result.push({ schemaSha256: manifest.schema.sha256, tables: manifest.tables.map(({ name, sql }) => ({ name, sql })) });
        assert.equal((await fence(false)).status, 200);
      }
      return result;
    };
    const schemas = await manifests();
    assert.deepEqual(schemas, [
      { schemaSha256: "cb65656e994843070fe0a7c733b5d1ee41c51c8fa955d8f4f3dcc23b3817feaf", tables: (schemas[0] as { tables: unknown[] }).tables },
      { schemaSha256: "547842274af34b4364f6aee6abe15c00a40590dcbac8e63fe2284457dc8504a3", tables: (schemas[1] as { tables: unknown[] }).tables }
    ]);
    assert.deepEqual((schemas[0] as { tables: { name: string }[] }).tables.map(table => table.name), [
      "collector_runs", "host_history_versions", "host_system", "hosts", "project_deployment_coverage",
      "project_deployment_sync", "project_deployment_versions", "project_deployments", "project_hours",
      "project_samples", "rollup_pending_hours", "rollups", "samples", "service_deployments", "services"
    ]);
    assert.deepEqual((schemas[1] as { tables: { name: string }[] }).tables.map(table => table.name), [
      "observe_applied_flushes", "observe_artifacts", "observe_counts", "observe_external_events",
      "observe_health_events", "observe_ingest_windows", "observe_invocations", "observe_issues",
      "observe_occurrences", "observe_operations", "observe_outcomes", "observe_profile",
      "observe_rollout_shares", "observe_rollouts", "observe_version_labels", "observe_write_cost"
    ]);
    assert.deepEqual(await (await fetch(`${origin}/api/v1/admin/objects`, { headers })).json(), before);
    assert.deepEqual(await manifests(), schemas);
    const hostResponse = await fetch(`${origin}/api/v1/admin/hosts`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name: "metrics-test" }) });
    assert.equal(hostResponse.status, 201);
    const host = await hostResponse.json() as { hostId: string };
    const claim = await fetch(`${origin}/api/v1/admin/services`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name: "stats-infra", hostIds: [host.hostId] }) });
    assert.equal(claim.status, 400);
    assert.match(await claim.text(), /reserved/);
    assert.equal((await fetch(query)).status, 401);
    assert.equal((await fetch(`${origin}/ingest/metrics/v1/batches`, { method: "POST", headers: { "content-type": "application/vnd.stats.infra-metrics.v2+json" }, body: "{}" })).status, 401);
    const stack = { origin, headers, release: "abcdef012345", historyRuns: [] } as unknown as Stack;
    const credentials = await prepare(stack);
    const workloadResult = await runWorkload(stack, credentials, origin);
    assert.ok(workloadResult.ledger.acknowledgedWrites >= 1);
    assert.ok(workloadResult.ledger.readbackVerified >= 1);
    assert.equal(workloadResult.ledger.lostWrites, 0);
    const observationRead = await fetch(`${origin}/api/observe/stats/external?from=${Date.now() - 60000}&to=${Date.now() + 60000}`, { headers });
    assert.equal(observationRead.status, 200);
    const trafficStart = Date.now();
    let traffic = true;
    const requestLoad = Array.from({ length: 24 }, async (_, index) => {
      const path = index < 4 ? "/api/v1/hosts" : "/api/v1/admin/objects/observe:stats/export/manifest";
      while (traffic) await fetch(origin + path, { headers }).then(response => response.arrayBuffer()).catch(() => undefined);
    });
    let actorValues: any[] = [];
    const observed = new Set<string>();
    try {
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        const response = await fetch(`${origin}/api/observe/stats-infra/metrics/sources?from=${trafficStart}&to=${Date.now()}&release=runtime`, { headers });
        if (response.ok) actorValues = (await response.json() as { sources: any[] }).sources;
        for (const role of ["installation", "observation-store"]) for (const family of ["rivet_rivetkit_actor_http_requests_active", "rivet_rivetkit_actor_sqlite_vfs_commit_total"]) {
          if (actorValues.some(source => source.detail.values?.[family]?.some(([labels, value]: any) => labels.actor_name === role && typeof value === "string" && Number(value) > 0))) observed.add(`${role}:${family}`);
        }
        if (observed.size === 4) break;
        await delay(500);
      }
      for (const role of ["installation", "observation-store"]) for (const family of ["rivet_rivetkit_actor_http_requests_active", "rivet_rivetkit_actor_sqlite_vfs_commit_total"]) {
        assert.ok(observed.has(`${role}:${family}`), `${role} ${family}: ${JSON.stringify(actorValues.map(source => ({ source: source.detail.source, active: source.detail.values?.rivet_rivetkit_actor_http_requests_active })))}`);
      }
    } finally { traffic = false; await Promise.all(requestLoad); }
    if (process.env.CAPTURE_METRICS === "1") {
      for (const index of [0, 1]) {
        const capture = await (await fetch(`http://127.0.0.1:${base + index}/metrics`)).text();
        writeFileSync(resolve(`fixtures/metrics/v1/scrapes/live-stats-${index}.prom`), capture);
      }
    }
    await stop(serve);
    output = "";
    serve = spawn(process.execPath, [
      bin(root), "serve", "--config", join(state, "stats.jsonc"), "--config", join(state, "observe.jsonc")
    ], {
      cwd: state,
      env: { ...process.env, PORT: String(port), RIVET_ENDPOINT: `http://default:canary@127.0.0.1:${guard}`, RIVETKIT_METRICS_PORT: String(base) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    serve.stdout!.on("data", c => { output += c; }); serve.stderr!.on("data", c => { output += c; });
    const restarted = Date.now() + 60000;
    while (!output.includes("orange serve listening on")) { assert.equal(serve.exitCode, null, output); assert.ok(Date.now() < restarted, output); await delay(200); }
    while (Date.now() < restarted) {
      const response = await fetch(query, { headers });
      if (response.ok) sources = (await response.json() as { sources: any[] }).sources;
      if (sources.some(source => source.detail.source === "worker:stats-observe:1" && source.detail.resets >= 1)) break;
      await delay(2500);
    }
    assert.ok(sources.some(source => source.detail.source === "worker:stats-observe:1" && source.detail.resets >= 1), JSON.stringify(sources));
    const applicationBefore = await (await fetch(`${origin}/api/v1/hosts`, { headers })).text();
    await stop(collector);
    collector = undefined;
    assert.equal(await (await fetch(`${origin}/api/v1/hosts`, { headers })).text(), applicationBefore);
    console.log("verified sources", sources.map(source => ({ source: source.detail.source, lastOkAtMs: source.detail.lastOkAtMs, resets: source.detail.resets })));

  } finally { await stop(collector); await stop(serve); await stop(engine); }
}

await test("collector delivers Worker and Engine metrics", { timeout: 120_000 }, async () => {
  const scratch = mkdtempSync(resolve(".work/tmp/metrics-test-"));
  try {
    const build = spawnSync(process.execPath, [resolve("cloudflare/scripts/build-infra-collector.mjs"), "--out", resolve(".work/tmp/infra-collector")], { encoding: "utf8" });
    assert.equal(build.status, 0, build.stderr);
    await metrics(ORANGE_ROOT, scratch);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
