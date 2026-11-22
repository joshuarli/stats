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
  writeFileSync(config, JSON.stringify({ topology: { datacenter_label: 1, datacenters: { default: { datacenter_label: 1, is_leader: true, peer_url: `http://127.0.0.1:${peer}/`, public_url: `http://127.0.0.1:${guard}/` } } } }));
  const requireFromClosure = createRequire(join(root, "package.json"));
  const requireFromRivet = createRequire(requireFromClosure.resolve("rivetkit"));
  const { getEnginePath } = requireFromRivet("@rivetkit/engine-cli") as { getEnginePath(): string };
  let output = "";
  const engine = spawn(getEnginePath(), ["--config", config], { cwd: engineDir, env: { ...process.env, RIVET__API_PEER__HOST: "127.0.0.1", RIVET__API_PEER__PORT: String(peer), RIVET__AUTH__ADMIN_TOKEN: "canary", RIVET__GUARD__HOST: "127.0.0.1", RIVET__GUARD__PORT: String(guard), RIVET__METRICS__HOST: "127.0.0.1", RIVET__METRICS__PORT: String(engineMetrics), RIVET__PEGBOARD__NODE_LOST_THRESHOLD: "7000", RIVET__OBJECT_STORAGE__PRIMARY__FILE_SYSTEM__PATH: join(engineDir, "objects"), RIVET__STORAGE__AUTO_PROVISION_PARTITIONS: "1", RIVET__STORAGE__BALANCING__ENABLED: "false", RIVET__STORAGE__COLD_STORE__DISK_CACHE_BYTES: "0", RIVET__STORAGE__LOG_DIRECTORY: join(engineDir, "log"), RIVET__STORAGE__LOG_SHARD__MAX_DISK_BYTES: String(1024 * 1024 * 1024) }, stdio: ["ignore", "pipe", "pipe"] });
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
    serve = spawn(process.execPath, [bin(root), "serve", "--config", join(state, "stats.jsonc"), "--config", join(state, "observe.jsonc")], { cwd: state, env: { ...process.env, PORT: String(port), RIVET_ENDPOINT: `http://default:canary@127.0.0.1:${guard}`, RIVETKIT_METRICS_PORT: String(base) }, stdio: ["ignore", "pipe", "pipe"] });
    serve.stdout!.on("data", c => { output += c; }); serve.stderr!.on("data", c => { output += c; });
    while (!output.includes("orange serve listening on")) { assert.equal(serve.exitCode, null, output); assert.ok(Date.now() < deadline, output); await delay(200); }
    const found = [];
    for (const [index, worker] of ["stats", "stats-observe"].entries()) {
      const response = await fetch(`http://127.0.0.1:${base + index}/metrics`);
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.ok(body.includes(`openorange_worker_info{worker="${worker}",index="${index}"} 1`), body);
      assert.match(body, /^openorange_worker_start_time_seconds [\d.]+$/m);
      found.push(body.match(/^openorange_worker_(?:info|start_time_seconds).*$/gm));
    }
    console.log("metrics", JSON.stringify({ base, workers: found }));
  } finally { await stop(serve); await stop(engine); }
}

await test("upstream runtime without worker metrics holds qualification and owned runtime exposes both metrics", { timeout: 600_000 }, async () => {
  const scratch = mkdtempSync(resolve(".work/tmp/runtime-canary-"));
  let baseline: Stack | undefined, candidate: Stack | undefined;
  try {
    const closure = join(scratch, "closure"); mkdirSync(closure);
    for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) copyFileSync(join(ORANGE_ROOT, name), join(closure, name));
    const packagePath = join(closure, "package.json");
    const pkg = JSON.parse(readFileSync(packagePath, "utf8")); pkg.dependencies["open-orange"] = "1.0.2";
    writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    const install = spawnSync("pnpm", ["install"], { cwd: closure, encoding: "utf8", timeout: 120_000 });
    assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
    const normalizedBaseline = join(scratch, "normalized-baseline"); mkdirSync(normalizedBaseline);
    for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) copyFileSync(join(ORANGE_ROOT, name), join(normalizedBaseline, name));
    const normalize = spawnSync("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], { cwd: normalizedBaseline, encoding: "utf8", timeout: 120_000 });
    assert.equal(normalize.status, 0, `${normalize.stdout}\n${normalize.stderr}`);
    const diff = spawnSync("diff", ["-u", join(normalizedBaseline, "pnpm-lock.yaml"), join(closure, "pnpm-lock.yaml")], { encoding: "utf8" });
    assert.equal(diff.status, 1, diff.stderr);
    const changed = diff.stdout.split("\n").filter(line => /^[+-]/.test(line) && !/^(---|\+\+\+)/.test(line));
    assert.equal(changed.length, 11, diff.stdout);
    const owned = { tarball: JSON.parse(readFileSync(join(ORANGE_ROOT, "package.json"), "utf8")).dependencies["open-orange"] as string, version: JSON.parse(readFileSync(join(ORANGE_ROOT, "node_modules/open-orange/package.json"), "utf8")).version as string };
    const ownedIntegrity = readFileSync(join(ORANGE_ROOT, "pnpm-lock.yaml"), "utf8").match(/open-orange@https:[^\n]*:\n\s+resolution: \{integrity: (sha512-[A-Za-z0-9+/=]+)/)?.[1];
    assert.ok(owned.tarball.startsWith("https://npm.17166969.xyz/") && /^1\.0\.2-laputa\.\d+$/.test(owned.version) && ownedIntegrity, "the pinned owned open-orange is unexpected");
    const allowed = [owned.tarball, `version: ${owned.version}`, `integrity: ${ownedIntegrity}`, "specifier: 1.0.2", "version: 1.0.2(", "open-orange@1.0.2", "integrity: sha512-6n2iAtsEdHFh"];
    assert.ok(changed.every(line => allowed.some(fragment => line.includes(fragment))), diff.stdout);
    console.log("lockfile diff", diff.stdout);
    for (const [dir, version] of [[closure, "1.0.2"], [ORANGE_ROOT, owned.version]]) {
      const result = spawnSync(process.execPath, [bin(dir!), "--version"], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), version); console.log("orange version", version);
    }
    const linuxRoots = [closure, ORANGE_ROOT].map((input, index) => {
      const target = join(scratch, `linux-${index}`); mkdirSync(target);
      for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) copyFileSync(join(input, name), join(target, name));
      const result = spawnSync("docker", ["run", "--rm", "-v", `${target}:/work`, "-w", "/work", "node@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5", "sh", "-ec", "npm install -g pnpm@12.21.0 >/dev/null && pnpm install --frozen-lockfile --prod --ignore-scripts"], { encoding: "utf8", timeout: 120_000 });
      assert.equal(result.status, 0, result.stderr);
      return target;
    });
    baseline = await startStack(join(scratch, "baseline"), "baseline", false, linuxRoots[0], true);
    candidate = await startStack(join(scratch, "candidate"), "candidate", false, linuxRoots[1], true);
    assert.notEqual(baseline.runtimeRoot, candidate.runtimeRoot);
    const from = Date.now() - 60_000;
    const [bc, cc] = await Promise.all([prepare(baseline), prepare(candidate)]);
    await Promise.all([waitCheckpoint(baseline, from, from), waitCheckpoint(candidate, from, from)]);
    const start = Date.now();
    const br = monitorResources(baseline), cr = monitorResources(candidate);
    const [left, right] = await Promise.all([runWorkload(baseline, bc, baseline.origin), runWorkload(candidate, cc, candidate.origin)]);
    const leftResources = br(), rightResources = cr();
    const end = Date.now();
    await Promise.all([fetch(`${baseline.origin}/api/v1/capabilities`, { headers: baseline.headers }), fetch(`${candidate.origin}/api/v1/capabilities`, { headers: candidate.headers })]);
    const [lo, ro] = await Promise.all([waitCheckpoint(baseline, from, end), waitCheckpoint(candidate, from, end)]);
    const observations = { baseline: { observer: { status: "ok", checkedAtMs: lo.checkedAtMs }, sources: [source(lo.rows, baseline.release, start, end)], truncated: lo.truncated, hostConfounded: false, resources: leftResources }, candidate: { observer: { status: "ok", checkedAtMs: ro.checkedAtMs }, sources: [source(ro.rows, candidate.release, start, end)], truncated: ro.truncated, hostConfounded: false, resources: rightResources } };
    const recovery = await recover(candidate, baseline, join(scratch, "recovery"), right);
    assert.equal(recovery.readbackVerified, true);
    const bundle = join(scratch, "evidence");
    const result = writeBundle(bundle, baseline, candidate, { baseline: left.ledger, candidate: right.ledger }, observations, recovery, start, end);
    assert.equal(result.status, 6, JSON.stringify(result.decision)); assert.equal(result.decision.verdict, "inconclusive");
    assert.ok(result.decision.reasons.some(reason => reason.code === "resources-missing"));
    const manifests = ["baseline", "candidate"].map(name => JSON.parse(readFileSync(join(bundle, `${name}.manifest.json`), "utf8")));
    for (const key of ["orange-package", "orange-lock", "orange-bin"]) assert.notEqual(manifests[0].components[key], manifests[1].components[key]);
    const replay = spawnSync("pnpm", ["--dir", "cloudflare", "-s", "statsctl", "verify", "release", "--evidence", bundle, "--replay", "--json"], { encoding: "utf8" });
    assert.equal(replay.status, 6, replay.stderr); assert.equal(JSON.parse(replay.stdout).payload.verdict, "inconclusive");
    console.log("manifests", JSON.stringify(manifests)); console.log("verdict", JSON.stringify(result.decision)); console.log("replay", replay.stdout.trim());
    await metrics(ORANGE_ROOT, join(scratch, "metrics"));
  } finally { await candidate?.stop(); await baseline?.stop(); rmSync(scratch, { recursive: true, force: true }); }
});
