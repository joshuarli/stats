import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { generate } from "./generate.mts";
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
  mkdirSync(join(directory, "engine", "log"), { recursive: true });
  const engineDir = join(directory, "engine");
  const state = join(directory, "state");
  const [guard, peer, engineMetrics, port] = await Promise.all(Array.from({ length: 4 }, () => freePort()));
  let base: number;
  for (;;) {
    base = await freePort();
    if (base === 65535) continue;
    const probe = createServer();
    if (await new Promise<boolean>(resolve => { probe.once("error", () => resolve(false)); probe.listen(base + 1, "127.0.0.1", () => probe.close(() => resolve(true))); })) break;
  }
  const config = join(engineDir, "config.json");
  writeFileSync(config, JSON.stringify({ topology: { datacenter_label: 1, datacenters: { default: { datacenter_label: 1, is_leader: true, peer_url: `http://127.0.0.1:${peer}/`, public_url: `http://127.0.0.1:${guard}/` } } } }));
  generate(state, { kind: "dev", release: "metrics", gatewaySecret: "metrics-secret", nowMs: null });
  const enginePath = join(root, "node_modules/.pnpm/@rivetkit+engine-cli-linux-x64-musl@3.1.2-rc.1/node_modules/@rivetkit/engine-cli-linux-x64-musl/rivet-engine");
  const name = `stats-metrics-${process.pid}`;
  const env: Record<string, string> = { RIVET__API_PEER__HOST: "127.0.0.1", RIVET__API_PEER__PORT: String(peer), RIVET__AUTH__ADMIN_TOKEN: "canary", RIVET__GUARD__HOST: "127.0.0.1", RIVET__GUARD__PORT: String(guard), RIVET__METRICS__HOST: "127.0.0.1", RIVET__METRICS__PORT: String(engineMetrics), RIVET__PEGBOARD__NODE_LOST_THRESHOLD: "7000", RIVET__OBJECT_STORAGE__PRIMARY__FILE_SYSTEM__PATH: join(engineDir, "objects"), RIVET__STORAGE__AUTO_PROVISION_PARTITIONS: "1", RIVET__STORAGE__BALANCING__ENABLED: "false", RIVET__STORAGE__COLD_STORE__DISK_CACHE_BYTES: "0", RIVET__STORAGE__LOG_DIRECTORY: join(engineDir, "log"), RIVET__STORAGE__LOG_SHARD__MAX_DISK_BYTES: String(1024 * 1024 * 1024), PORT: String(port), RIVET_ENDPOINT: `http://default:canary@127.0.0.1:${guard}`, RIVETKIT_METRICS_PORT: String(base) };
  const script = `"$1" --config "$2" &
node -e 'const u=process.argv[1]; (async()=>{for(let i=0;i<240;i++){try{if((await fetch(u,{headers:{authorization:"Bearer canary"}})).status===200)return}catch{} await new Promise(r=>setTimeout(r,500))}process.exit(1)})()' "http://127.0.0.1:${guard}/actors/names?namespace=default"
exec node "$3" serve --config "$4" --config "$5"`;
  const args = ["run", "--rm", "--platform", "linux/amd64", "--name", name, "--mount", `type=bind,src=${resolve(".")},dst=${resolve(".")},readonly`, "--mount", `type=bind,src=${directory},dst=${directory}`, "--mount", `type=bind,src=${root},dst=${root},readonly`, "-w", engineDir, ...Object.entries(env).flatMap(([k,v]) => ["-e", `${k}=${v}`]), "node@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5", "sh", "-ec", script, "sh", enginePath, config, bin(root), join(state, "stats.jsonc"), join(state, "observe.jsonc")];
  let output = "";
  const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", c => { output += c; }); child.stderr!.on("data", c => { output += c; });
  try {
    const deadline = Date.now() + 180_000;
    while (!output.includes("orange serve listening on")) { assert.equal(child.exitCode, null, output); assert.ok(Date.now() < deadline, output); await delay(250); }
    for (const [index, worker] of ["stats", "stats-observe"].entries()) {
      const response = spawnSync("docker", ["exec", name, "node", "-e", "fetch(process.argv[1]).then(async r => { if (!r.ok) process.exit(1); process.stdout.write(await r.text()) }).catch(() => process.exit(1))", `http://127.0.0.1:${base + index}/metrics`], { encoding: "utf8" });
      assert.equal(response.status, 0, response.stderr);
      const body = response.stdout;
      assert.ok(body.includes(`openorange_worker_info{worker="${worker}",index="${index}"} 1`), body);
      assert.match(body, /^openorange_worker_start_time_seconds [\d.]+$/m);
      console.log("metrics", worker, body.match(/^openorange_worker_(?:info|start_time_seconds).*$/gm));
    }
  } finally { spawnSync("docker", ["stop", "-t", "10", name]); await stop(child); }
}

await test("owned runtime passes the release canary and exposes both worker metrics", { timeout: 900_000 }, async () => {
  const scratch = mkdtempSync(resolve(".work/tmp/runtime-canary-"));
  let baseline: Stack | undefined, candidate: Stack | undefined;
  try {
    const roots = ["baseline", "candidate"].map(name => join(scratch, name + "-runtime"));
    const artifacts = [process.env.RUNTIME_ARTIFACT_BASELINE ?? ".work/tmp/artifact-baseline", process.env.RUNTIME_ARTIFACT_CANDIDATE ?? ".work/tmp/artifact-A"].map(dir => resolve(dir));
    const manifests = artifacts.map(dir => JSON.parse(readFileSync(join(dir, "artifact.json"), "utf8")));
    for (const [index, dir] of artifacts.entries()) {
      const archive = join(dir, "runtime.tar");
      assert.equal(hash(archive), manifests[index].tar_sha256);
      mkdirSync(roots[index]!);
      const extract = spawnSync("tar", ["-xf", archive, "-C", roots[index]!], { encoding: "utf8" });
      assert.equal(extract.status, 0, extract.stderr);
    }
    const releaseIds = manifests.map(manifest => "rt-" + String(manifest.closure_digest).slice("sha256:".length, "sha256:".length + 12));
    baseline = Object.assign(await startStack(join(scratch, "baseline"), releaseIds[0]!, false, roots[0], true), { closureDigest: manifests[0].closure_digest });
    candidate = Object.assign(await startStack(join(scratch, "candidate"), releaseIds[1]!, false, roots[1], true), { closureDigest: manifests[1].closure_digest });
    const from = Date.now() - 60_000;
    const [bc, cc] = await Promise.all([prepare(baseline), prepare(candidate)]);
    await Promise.all([waitCheckpoint(baseline, from, from), waitCheckpoint(candidate, from, from)]);
    const br = monitorResources(baseline), cr = monitorResources(candidate);
    const start = Date.now() + 1; while (Date.now() <= start) await delay(5);
    const [left, right] = await Promise.all([runWorkload(baseline, bc, baseline.origin), runWorkload(candidate, cc, candidate.origin)]);
    const end = Date.now();
    await Promise.all([fetch(`${baseline.origin}/api/v1/capabilities`, { headers: baseline.headers }), fetch(`${candidate.origin}/api/v1/capabilities`, { headers: candidate.headers })]);
    const [lo, ro] = await Promise.all([waitCheckpoint(baseline, from, end), waitCheckpoint(candidate, from, end)]);
    const observations = { baseline: { observer: { status: "ok", checkedAtMs: lo.checkedAtMs }, sources: [source(lo.rows, baseline.release, start, end)], truncated: lo.truncated, hostConfounded: false, resources: br() }, candidate: { observer: { status: "ok", checkedAtMs: ro.checkedAtMs }, sources: [source(ro.rows, candidate.release, start, end)], truncated: ro.truncated, hostConfounded: false, resources: cr() } };
    const recovery = await recover(candidate, baseline, join(scratch, "recovery"), right);
    assert.equal(recovery.readbackVerified, true);
    const bundle = join(scratch, "evidence");
    const result = writeBundle(bundle, baseline, candidate, { baseline: left.ledger, candidate: right.ledger }, observations, recovery, start, end);
    assert.equal(result.status, 0, JSON.stringify(result.decision)); assert.equal(result.decision.verdict, "pass");
    const evidenceManifests = ["baseline", "candidate"].map(name => JSON.parse(readFileSync(join(bundle, `${name}.manifest.json`), "utf8")));
    assert.equal(evidenceManifests[1].components["runtime-closure"], manifests[1].closure_digest);
    assert.notEqual(evidenceManifests[0].components["runtime-closure"], evidenceManifests[1].components["runtime-closure"]);
    const replay = spawnSync("pnpm", ["--dir", "cloudflare", "-s", "statsctl", "verify", "release", "--evidence", bundle, "--replay", "--json"], { encoding: "utf8" });
    assert.equal(replay.status, 0, replay.stderr); assert.equal(JSON.parse(replay.stdout).payload.verdict, "pass");
    console.log("manifests", JSON.stringify(manifests)); console.log("verdict", JSON.stringify(result.decision)); console.log("replay", replay.stdout.trim());
    if (String(manifests[1].open_orange_version).includes("-laputa.")) await metrics(roots[1]!, join(scratch, "metrics"));
    const retained = mkdtempSync(resolve(".work/tmp/runtime-artifact-evidence-"));
    cpSync(bundle, retained, { recursive: true });
    console.log("evidence", retained);
  } finally { await candidate?.stop(); await baseline?.stop(); rmSync(scratch, { recursive: true, force: true }); }
});
