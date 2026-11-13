import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, cpSync } from "node:fs";
import { join } from "node:path";
import { INGEST_MEDIA_TYPE } from "../../../cloudflare/src/ingest/http.ts";
import { decodeAck } from "../../../cloudflare/src/ingest/ack-decode.ts";
import { encodeFrame } from "../../../cloudflare/src/ingest/encode.ts";
import { fixtureBytes, fixtureSource, withHost } from "../../../cloudflare/test/node/support.ts";
import { accessToken } from "../../../cloudflare/test/access-token.ts";
import { BIN, EXPERIMENTS, freePort, historyFingerprint, processTree, startSession, waitForHttp, generate, ROOT, OFFLINE, type Session } from "./harness.mts";

export interface ResilienceOptions { readonly runId: string; readonly soakMinutes?: number; readonly reloads?: number }

const seqsOf = (offset = 0): readonly bigint[] => fixtureSource("sources/linux-normal.json").samples.map(sample => BigInt(String((sample as { seq: unknown }).seq)) + BigInt(offset));
const frameOf = (hostId: string, offset = 0): Uint8Array => offset === 0 ? withHost(fixtureBytes("frames/linux-normal.stb2"), hostId) : withHost(encodeFrame({ ...fixtureSource("sources/linux-normal.json"), samples: fixtureSource("sources/linux-normal.json").samples.map(sample => { const s = sample as Record<string, unknown>; const shift = BigInt(offset) * 1000n; return { ...s, seq: String(BigInt(String(s.seq)) + BigInt(offset)), monoMs: String(BigInt(String(s.monoMs)) + shift), atMs: String(BigInt(String(s.atMs)) + shift) }; }) }), hostId);

export async function historyFingerprintAt(origin: string, access: Record<string, string>, hostId: string): Promise<string> {
  const history = await fetch(`${origin}/api/v1/hosts/${hostId}/history?range=24h&kind=summary`, { headers: { ...access, "accept-encoding": "identity" } });
  return historyFingerprint(new Uint8Array(await history.arrayBuffer()));
}

export async function seedAcknowledged(stateDir: string): Promise<{ hostId: string; token: string; fingerprint: string }> {
  let session: Session | undefined;
  try {
    session = await startSession(stateDir, await freePort(), true);
    const access = { "cf-access-jwt-assertion": await accessToken() };
    const created = await fetch(`${session.origin}/api/v1/admin/hosts`, { method: "POST", headers: { ...access, "Content-Type": "application/json" }, body: JSON.stringify({ name: "resilience-seed" }) });
    if (created.status !== 201) throw new Error(`createHost returned ${created.status}`);
    const { hostId, token } = await created.json() as { hostId: string; token: string };
    const ingest = await fetch(`${session.origin}/ingest/v2/batches`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": INGEST_MEDIA_TYPE }, body: frameOf(hostId) });
    const ack = decodeAck(new Uint8Array(await ingest.arrayBuffer()), seqsOf());
    if (ingest.status !== 200 || ack.accepted !== 2) throw new Error(`seed rejected: ${ingest.status}`);
    return { hostId, token, fingerprint: await historyFingerprintAt(session.origin, access, hostId) };
  } finally {
    await session?.stop().catch(() => {});
  }
}

async function verifyAfterRecovery(stateDir: string, seed: { hostId: string; token: string; fingerprint: string }): Promise<{ verified: boolean; historyBytes: number }> {
  let session: Session | undefined;
  try {
    session = await startSession(stateDir, await freePort(), true);
    const access = { "cf-access-jwt-assertion": await accessToken() };
    const history = await fetch(`${session.origin}/api/v1/hosts/${seed.hostId}/history?range=24h&kind=summary`, { headers: { ...access, "accept-encoding": "identity" } });
    const bytes = new Uint8Array(await history.arrayBuffer());
    const replay = await fetch(`${session.origin}/ingest/v2/batches`, { method: "POST", headers: { Authorization: `Bearer ${seed.token}`, "Content-Type": INGEST_MEDIA_TYPE }, body: frameOf(seed.hostId) });
    const ack = decodeAck(new Uint8Array(await replay.arrayBuffer()), seqsOf());
    const matches = historyFingerprint(bytes) === seed.fingerprint;
    return { verified: matches && replay.status === 200 && ack.duplicates === 2, historyBytes: bytes.byteLength };
  } finally {
    await session?.stop().catch(() => {});
  }
}

async function killWhere(session: Session, pattern: RegExp): Promise<number> {
  const tree = processTree(session.child.pid!).processes;
  const targets = tree.filter(row => pattern.test(row.command)).map(row => row.pid);
  for (const pid of targets) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  await session.stop().catch(() => {});
  for (const row of processTree(session.child.pid!).processes) try { process.kill(row.pid, "SIGKILL"); } catch { /* already gone */ }
  return targets.length;
}

const exitOf = (child: import("node:child_process").ChildProcess, graceMs = 10_000): Promise<void> => new Promise<void>(done => { const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, graceMs); child.once("exit", () => { clearTimeout(timer); done(); }); });

export async function runResilience(options: ResilienceOptions): Promise<Record<string, unknown>> {
  const checks: Record<string, unknown> = {}; const failures: string[] = [];
  const check = (name: string, ok: boolean, detail?: unknown) => { checks[name] = detail === undefined ? ok : { ok, detail }; if (!ok) failures.push(name); };
  if (!existsSync(BIN) || !existsSync(join(EXPERIMENTS, "package.json"))) return { command: "resilience", result: "blocked", reason: "candidate bootstrap missing; run node scripts/rivet-eval.mjs bootstrap", checks, failures };
  if (process.platform !== "darwin") return { command: "resilience", result: "blocked", reason: "R5 is verified under the macOS offline sandbox (scripts/offline-run.sh); Linux runtime is Needs environment", checks, failures };
  const { ensureBuilds } = await import("../../../cloudflare/scripts/ensure-build.ts");
  await ensureBuilds(["stats", "observe"], { signal: new AbortController().signal });
  const runRoot = join(ROOT, ".work/rivet-eval", options.runId, "resilience");
  rmSync(runRoot, { recursive: true, force: true }); const started = performance.now();

  for (const [name, pattern] of [["app", /^(?!.*rivet-(engine|services)).*$/u], ["engine", /rivet-engine/u], ["services", /rivet-services/u]] as const) {
    const stateDir = join(runRoot, `state-${name}`);
    generate({ outDir: stateDir });
    try {
      const seed = await seedAcknowledged(stateDir);
      const session = await startSession(stateDir, await freePort(), true);
      const killed = await killWhere(session, pattern);
      const recovery = await verifyAfterRecovery(stateDir, seed);
      check(`kill:${name}`, recovery.verified, { killed, historyBytes: recovery.historyBytes });
    } catch (error) {
      check(`kill:${name}`, false, String(error instanceof Error ? error.message : error).slice(0, 300));
    }
  }

  const isoA = join(runRoot, "iso-a"); const isoB = join(runRoot, "iso-b");
  generate({ outDir: isoA }); generate({ outDir: isoB });
  let sessionA: Session | undefined; let sessionB: Session | undefined;
  try {
    sessionA = await startSession(isoA, await freePort(), true);
    sessionB = await startSession(isoB, await freePort(), true);
    const access = { "cf-access-jwt-assertion": await accessToken() };
    const created = await fetch(`${sessionA.origin}/api/v1/admin/hosts`, { method: "POST", headers: { ...access, "Content-Type": "application/json" }, body: JSON.stringify({ name: "iso-host" }) });
    const listB = await (await fetch(`${sessionB.origin}/api/v1/hosts`, { headers: access })).json() as { hosts: { name?: string }[] };
    check("isolatedSessions", created.status === 201 && !listB.hosts.some(entry => entry.name === "iso-host"), { aCreated: created.status, bNames: listB.hosts.map(entry => entry.name) });
  } catch (error) {
    check("isolatedSessions", false, String(error instanceof Error ? error.message : error).slice(0, 300));
  } finally {
    await sessionA?.stop().catch(() => {});
    await sessionB?.stop().catch(() => {});
  }

  const canary = execFileSync(OFFLINE, [process.execPath, "-e", "const {createServer}=require('node:http');const s=createServer((q,r)=>r.end('ok'));s.listen(0,'127.0.0.1',async()=>{const p=s.address().port;try{const r=await fetch('http://127.0.0.1:'+p+'/');console.log('loopback',r.status)}catch{console.log('loopback-fail')}try{await fetch('http://192.0.2.1:80/',{signal:AbortSignal.timeout(3000)});console.log('external reachable')}catch{console.log('external denied')}process.exit(0)})"], { encoding: "utf8", timeout: 15000 }).trim();
  check("offlineCanary", canary.includes("loopback 200") && canary.includes("denied"), canary);

  try {
    const pkgDir = join(runRoot, "packaged"), outDir = join(pkgDir, "state"), engineStorage = join(pkgDir, "engine-storage");
    generate({ outDir });
    const savedStoragePath = process.env["RIVETKIT_STORAGE_PATH"], savedRunEngine = process.env["RIVET_RUN_ENGINE"];
    process.env["RIVETKIT_STORAGE_PATH"] = engineStorage;
    process.env["RIVET_RUN_ENGINE"] = "1";
    const { setup, actor } = await import("rivetkit");
    const { db } = await import("rivetkit/db");
    const probe = actor({ db: db(), actions: { ping() { return "pong"; } } });
    const enginePort = await freePort();
    const httpPort = await freePort();
    const registry = setup({ use: { probe }, namespace: "default", sqlite: { backend: "local" }, startEngine: true, engineVersion: "3.1.1", httpPort, enginePort, noWelcome: true });
    await registry.startAndWait();
    const runtimePath = join(engineStorage, ".rivetkit/var/engine/runtime.json");
    let endpoint = "";
    for (let attempt = 0; attempt < 180; attempt += 1) {
      if (existsSync(runtimePath)) { const runtime = JSON.parse(readFileSync(runtimePath, "utf8")) as { endpoint?: string }; if (typeof runtime.endpoint === "string") { endpoint = runtime.endpoint; break; } }
      await new Promise(resolveWait => setTimeout(resolveWait, 500));
    }
    if (endpoint === "") throw new Error("engine did not publish runtime.json within 90s");
    const serveOnce = async () => {
      const port = await freePort();
      const serve = spawn(process.execPath, [BIN, "serve", "--config", join(outDir, "stats.jsonc"), "--config", join(outDir, "observe.jsonc"), "--port", String(port), "--ip", "127.0.0.1"], { env: { ...process.env, RIVET_ENDPOINT: endpoint, RIVET_TOKEN: "default", RIVET_NAMESPACE: "default" }, stdio: ["ignore", "pipe", "pipe"] });
      const origin = `http://127.0.0.1:${port}`;
      await waitForHttp(origin, "/health", {}, 60_000);
      return { serve, origin };
    };
    const access = { "cf-access-jwt-assertion": await accessToken() };
    const first = await serveOnce();
    const created = await fetch(`${first.origin}/api/v1/admin/hosts`, { method: "POST", headers: { ...access, "Content-Type": "application/json" }, body: JSON.stringify({ name: "packaged-selfhost" }) });
    if (created.status !== 201) throw new Error(`packaged createHost returned ${created.status}`);
    const { hostId, token } = await created.json() as { hostId: string; token: string };
    const ingest = await fetch(`${first.origin}/ingest/v2/batches`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": INGEST_MEDIA_TYPE }, body: frameOf(hostId) });
    const ack = decodeAck(new Uint8Array(await ingest.arrayBuffer()), seqsOf());
    if (ingest.status !== 200 || ack.accepted !== 2) throw new Error(`packaged ingest rejected: ${ingest.status}`);
    const before = await historyFingerprintAt(first.origin, access, hostId);
    first.serve.kill("SIGTERM");
    await exitOf(first.serve);
    const second = await serveOnce();
    const after = await historyFingerprintAt(second.origin, access, hostId);
    const packagedAuth = await fetch(`${second.origin}/api/v1/hosts`);
    const packagedWrongAuth = await fetch(`${second.origin}/api/v1/hosts`, { headers: { "cf-access-jwt-assertion": "not-a-jwt" } });
    const unauthenticatedEngine = await fetch(endpoint, { headers: {} }).catch(() => null);
    second.serve.kill("SIGTERM");
    await exitOf(second.serve);
    await registry.shutdown();
    if (savedStoragePath === undefined) delete process.env["RIVETKIT_STORAGE_PATH"]; else process.env["RIVETKIT_STORAGE_PATH"] = savedStoragePath;
    if (savedRunEngine === undefined) delete process.env["RIVET_RUN_ENGINE"]; else process.env["RIVET_RUN_ENGINE"] = savedRunEngine;
    check("packagedSelfHost", after === before && (unauthenticatedEngine === null || unauthenticatedEngine.status !== 200) && packagedAuth.status === 401 && packagedWrongAuth.status === 401, { engineEndpoint: endpoint, historyMatch: after === before, missingJwt: packagedAuth.status, badJwt: packagedWrongAuth.status, engineProbe: unauthenticatedEngine?.status ?? "unreachable" });
  } catch (error) {
    for (const key of ["RIVETKIT_STORAGE_PATH", "RIVET_RUN_ENGINE"]) delete process.env[key];
    check("packagedSelfHost", false, String(error instanceof Error ? error.message : error).slice(0, 500));
  }

  try {
    const snapDir = join(runRoot, "state-snapshot");
    generate({ outDir: snapDir });
    const snapSeed = await seedAcknowledged(snapDir);
    const backup = join(runRoot, "snapshot-backup");
    rmSync(backup, { recursive: true, force: true });
    cpSync(snapDir, backup, { recursive: true }); rmSync(snapDir, { recursive: true, force: true }); cpSync(backup, snapDir, { recursive: true });
    const snapVerification = await verifyAfterRecovery(snapDir, snapSeed);
    check("snapshotRestore", snapVerification.verified, { ...snapVerification, note: "stop-the-world filesystem copy of the full synthetic state dir; not a supported online export; same-namespace restore" });
  } catch (error) {
    check("snapshotRestore", false, String(error instanceof Error ? error.message : error).slice(0, 300));
  }

  if (options.soakMinutes !== undefined && options.soakMinutes > 0) {
    const soakDir = join(runRoot, "soak");
    generate({ outDir: soakDir });
    const reloads = options.reloads ?? 100; const paceMs = (options.soakMinutes * 60_000) / reloads; const soakStart = performance.now();
    try {
      const seed = await seedAcknowledged(soakDir);
      const rssSamples: number[] = [];
      let accepted = 0, rejected = 0, peakRssKiB = 0;
      for (let reload = 1; reload <= reloads; reload += 1) {
        const offset = reload * 2;
        let cycle: Session | undefined;
        try {
          cycle = await startSession(soakDir, await freePort(), true);
          const ingest = await fetch(`${cycle.origin}/ingest/v2/batches`, { method: "POST", headers: { Authorization: `Bearer ${seed.token}`, "Content-Type": INGEST_MEDIA_TYPE }, body: frameOf(seed.hostId, offset) });
          const ack = decodeAck(new Uint8Array(await ingest.arrayBuffer()), seqsOf(offset));
          if (ingest.status === 200 && ack.accepted === 2) accepted += 2; else rejected += 1;
          peakRssKiB = Math.max(peakRssKiB, processTree(cycle.child.pid!).processes.reduce((sum, row) => sum + row.rssKiB, 0));
          rssSamples.push(peakRssKiB);
          if (peakRssKiB > 4 * 1024 * 1024) { check("soak", false, { accepted, rejected, peakRssKiB }); break; }
        } catch {
          rejected += 1;
        } finally {
          await cycle?.stop().catch(() => {});
        }
        const remaining = soakStart + reload * paceMs - performance.now();
        if (remaining > 0) await new Promise<void>(resolveWait => setTimeout(resolveWait, remaining));
      }
      let recoveredVerified = false; let historyBytes = 0;
      let verify: Session | undefined;
      try {
        verify = await startSession(soakDir, await freePort(), true);
        const access = { "cf-access-jwt-assertion": await accessToken() };
        const history = await fetch(`${verify.origin}/api/v1/hosts/${seed.hostId}/history?range=24h&kind=summary`, { headers: { ...access, "accept-encoding": "identity" } });
        historyBytes = (await history.arrayBuffer()).byteLength;
        const replay = await fetch(`${verify.origin}/ingest/v2/batches`, { method: "POST", headers: { Authorization: `Bearer ${seed.token}`, "Content-Type": INGEST_MEDIA_TYPE }, body: frameOf(seed.hostId) });
        const ack = decodeAck(new Uint8Array(await replay.arrayBuffer()), seqsOf());
        recoveredVerified = history.status === 200 && historyBytes > 0 && replay.status === 200 && ack.duplicates === 2;
      } finally {
        await verify?.stop().catch(() => {});
      }
      check("soak", rejected === 0 && recoveredVerified, { reloads, acceptedSamples: accepted, rejectedRequests: rejected, peakRssKiB: Math.max(...rssSamples), restartVerified: recoveredVerified, historyBytes });
    } catch (error) {
      check("soak", false, String(error instanceof Error ? error.message : error).slice(0, 300));
    }
  }

  return {
    command: "resilience",
    result: failures.length === 0 ? "pass" : "fail",
    reason: failures.length === 0 ? null : failures.join("; "),
    checks,
    failures,
    limits: {
      stateDir: runRoot,
      unproven: [
        "Alarm delivery across restart not exercised (DO storage.setAlarm; shortest real delay >=10 minutes)",
        "Fresh-namespace restore not proven (no supported export API; same-namespace stop-the-world copy only)",
        "Receiver backlog under soak not proven (collect/receiver untested at load)",
      ],
    },
    run: { elapsedMs: Math.round(performance.now() - started) },
  };
}

if (import.meta.main) {
  const runId = process.argv[2] ?? `resilience-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
  const soakArg = process.argv.indexOf("--soak-minutes");
  const result = await runResilience({ runId, ...(soakArg === -1 ? {} : { soakMinutes: Number(process.argv[soakArg + 1]), ...(process.argv.includes("--reloads") ? { reloads: Number(process.argv[process.argv.indexOf("--reloads") + 1]) } : {}) }) });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.result === "pass" ? 0 : result.result === "fail" ? 1 : 2);
}
