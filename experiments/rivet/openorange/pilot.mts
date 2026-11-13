import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { decodeAck } from "../../../cloudflare/src/ingest/ack-decode.ts";
import { openHistory } from "../../../cloudflare/src/binary/history.ts";
import { INGEST_MEDIA_TYPE } from "../../../cloudflare/src/ingest/http.ts";
import { encodeFrame } from "../../../cloudflare/src/ingest/encode.ts";
import { fixtureBytes, fixtureSource, manifest, withHost } from "../../../cloudflare/test/node/support.ts";
import { accessToken } from "../../../cloudflare/test/access-token.ts";
import { generate, ROOT } from "./generate.mjs";

const EXPERIMENTS = resolve(ROOT, "experiments/rivet");
const BIN = join(EXPERIMENTS, "node_modules", "open-orange", "dist", "bin.js");
const OFFLINE = join(ROOT, "scripts/offline-run.sh");
const HOST_INGEST_TYPE = INGEST_MEDIA_TYPE;

export interface PilotOptions {
  readonly runId: string;
  readonly sandbox?: boolean;
}

function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(() => done(typeof address === "object" && address !== null ? address.port : 0)); });
  });
}

function processTree(rootPid: number): { processes: readonly { pid: number; ppid: number; rssKiB: number; command: string }[] } {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,command="], { encoding: "utf8" }).trim().split("\n")
    .map(line => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u.exec(line)!).map(match => ({ pid: Number(match[1]), ppid: Number(match[2]), rssKiB: Number(match[3]), command: match[4]! }));
  const included = new Set<number>([rootPid]);
  for (let previous = -1; previous !== included.size;) { previous = included.size; for (const row of rows) if (included.has(row.ppid)) included.add(row.pid); }
  return { processes: rows.filter(row => included.has(row.pid)) };
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString("base64") };
  if (value instanceof Float64Array) return { $f64: [...value] };
  if (value instanceof BigUint64Array) return { $u64: [...value].map(entry => entry.toString()) };
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeValue(entry)]));
  return value;
}

function historyFingerprint(bytes: Uint8Array): string {
  const view = openHistory(bytes).root;
  return JSON.stringify(normalizeValue(view));
}

interface Session {
  readonly origin: string;
  readonly child: import("node:child_process").ChildProcess;
  readonly readyMs: number;
  readonly logs: readonly string[];
  stop(): Promise<void>;
}

async function startSession(stateDir: string, port: number, sandbox: boolean): Promise<Session> {
  const args = [BIN, "dev", "--json", "--ip", "127.0.0.1", "--port", String(port), "--config", join(stateDir, "stats.jsonc"), "--config", join(stateDir, "observe.jsonc")];
  const command = sandbox ? OFFLINE : process.execPath;
  const commandArgs = sandbox ? [process.execPath, ...args] : args;
  const child = spawn(command, commandArgs, { cwd: stateDir, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const logs: string[] = [];
  let ready: { origin: string; elapsedMs: number } | undefined;
  let failed: Error | undefined;
  const started = performance.now();
  child.stdout!.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim() === "") continue;
      logs.push(line);
      try {
        const event = JSON.parse(line) as { type?: string; url?: string; elapsedMs?: number; message?: string };
        if (event.type === "ready" && typeof event.url === "string") ready = { origin: event.url, elapsedMs: event.elapsedMs ?? (performance.now() - started) };
        else if (event.type === "error" || event.type === "fatal") failed ??= new Error(event.message ?? line);
      } catch { /* non-JSON output retained in logs */ }
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => { for (const line of chunk.toString("utf8").split("\n")) if (line.trim() !== "") logs.push(`stderr: ${line}`); });
  child.on("exit", code => { if (ready === undefined) failed ??= new Error(`orange dev exited (${code}) before ready`); });
  child.on("error", error => { failed ??= error instanceof Error ? error : new Error(String(error)); });
  const deadline = performance.now() + 120_000;
  while (ready === undefined && failed === undefined && performance.now() < deadline) await new Promise(resolveWait => setTimeout(resolveWait, 50));
  if (failed !== undefined) throw failed;
  if (ready === undefined) throw new Error(`orange dev did not report ready within 120s; logs:\n${logs.join("\n")}`);
  return {
    origin: ready.origin,
    child,
    readyMs: Math.round(ready.elapsedMs),
    logs,
    async stop() {
      child.kill("SIGTERM");
      const deadline = performance.now() + 10_000;
      while (child.exitCode === null && child.signalCode === null && performance.now() < deadline) await new Promise(resolveWait => setTimeout(resolveWait, 50));
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await new Promise<void>(done => { if (child.exitCode !== null || child.signalCode !== null) done(); else child.once("exit", () => done()); });
    },
  };
}

async function waitForHttp(origin: string, path: string, access: Record<string, string>, timeoutMs = 30_000): Promise<Response> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${origin}${path}`, { headers: access });
      return response;
    } catch (error) {
      if (performance.now() > deadline) throw error;
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
  }
}

export async function runPilot(options: PilotOptions): Promise<Record<string, unknown>> {
  const checks: Record<string, unknown> = {};
  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail?: unknown) => { checks[name] = detail === undefined ? ok : { ok, detail }; if (!ok) failures.push(`${name}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`); };
  const bootstrap = existsSync(BIN) && existsSync(join(EXPERIMENTS, "package.json")) && existsSync(join(EXPERIMENTS, "pnpm-lock.yaml"));
  if (!bootstrap) return { command: "pilot", result: "blocked", reason: "candidate bootstrap missing; run node scripts/rivet-eval.mjs bootstrap", checks, failures };
  const { ensureBuilds } = await import("../../../cloudflare/scripts/ensure-build.ts");
  await ensureBuilds(["stats", "observe"], { signal: new AbortController().signal });
  const runRoot = join(ROOT, ".work/rivet-eval", options.runId, "pilot");
  const stateDir = join(runRoot, "state");
  rmSync(runRoot, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  const generated = generate({ outDir: stateDir });
  const sandbox = options.sandbox ?? (process.platform === "darwin" && existsSync(OFFLINE));
  if (options.sandbox === true && process.platform !== "darwin") {
    return { command: "pilot", result: "blocked", reason: "OS-enforced network sandbox is macOS-only (scripts/offline-run.sh); on this host rerun with RIVET_PILOT_NO_SANDBOX=1 and record the limitation", checks, failures };
  }
  const access = { "cf-access-jwt-assertion": await accessToken() };
  const linuxNormal = manifest.batches.find(entry => entry.name === "linux-normal")!;
  const frame = fixtureBytes(linuxNormal.frame);
  const samples = fixtureSource(linuxNormal.source).samples;
  let session: Session | undefined;
  const started = performance.now();
  try {
    session = await startSession(stateDir, await freePort(), sandbox);
    checks["startup"] = { readyMs: session.readyMs, sandbox, origin: session.origin };
    const health = await waitForHttp(session.origin, "/health", {});
    check("health", health.status === 200 && (await health.json() as { ok?: boolean }).ok === true, `status ${health.status}`);

    const created = await fetch(`${session.origin}/api/v1/admin/hosts`, { method: "POST", headers: { ...access, "Content-Type": "application/json" }, body: JSON.stringify({ name: "rivet-pilot" }) });
    const createdBody = await created.json() as { hostId?: string; token?: string };
    check("createHost", created.status === 201 && typeof createdBody.hostId === "string" && typeof createdBody.token === "string", `status ${created.status}`);
    const hostId = createdBody.hostId!;
    const token = createdBody.token!;

    const hostFrame = withHost(frame, hostId);
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": HOST_INGEST_TYPE };
    const first = await fetch(`${session.origin}/ingest/v2/batches`, { method: "POST", headers, body: hostFrame });
    const firstAck = decodeAck(new Uint8Array(await first.arrayBuffer()), samples.map(sample => BigInt(String((sample as { seq: unknown }).seq))));
    check("ingest", first.status === 200 && firstAck.accepted === samples.length && firstAck.duplicates === 0, { status: first.status, accepted: firstAck.accepted, duplicates: firstAck.duplicates });

    const replay = await fetch(`${session.origin}/ingest/v2/batches`, { method: "POST", headers, body: hostFrame });
    const replayAck = decodeAck(new Uint8Array(await replay.arrayBuffer()), samples.map(sample => BigInt(String((sample as { seq: unknown }).seq))));
    check("replay", replay.status === 200 && replayAck.duplicates === samples.length && replayAck.accepted === 0, { status: replay.status, duplicates: replayAck.duplicates, accepted: replayAck.accepted });

    const baseSource = fixtureSource(linuxNormal.source);
    const conflictSource = { ...baseSource, samples: baseSource.samples.map(sample => ({ ...sample, cpu: { ...(sample.cpu as Record<string, unknown>), total: "999999999999" } })) };
    const conflictFrame = withHost(encodeFrame(conflictSource), hostId);
    const conflict = await fetch(`${session.origin}/ingest/v2/batches`, { method: "POST", headers, body: conflictFrame });
    const conflictBody = await conflict.json() as { error?: { code?: string }; rejected?: readonly { seq: string; code: string }[] };
    check("conflict", conflict.status === 400 && (conflictBody.rejected ?? []).every(entry => entry.code === "conflict"), { status: conflict.status, body: conflictBody });

    const historyUrl = `/api/v1/hosts/${hostId}/history?range=24h&kind=summary`;
    const before = await fetch(`${session.origin}${historyUrl}`, { headers: { ...access, "accept-encoding": "identity" } });
    const beforeBody = new Uint8Array(await before.arrayBuffer());
    const historyType = before.headers.get("content-type");
    let fingerprint: string | null = null;
    try { fingerprint = historyFingerprint(beforeBody); } catch (error) { fingerprint = null; check("historyDecode", false, String(error)); }
    check("history", before.status === 200 && historyType === "application/vnd.stats.history.v1" && fingerprint !== null, { status: before.status, contentType: historyType });

    checks["processesBeforeRestart"] = processTree(session.child.pid!).processes.map(row => ({ pid: row.pid, ppid: row.ppid, rssKiB: row.rssKiB, command: row.command.slice(0, 160) }));
    await session.stop();
    const stopped = session; session = undefined;

    session = await startSession(stateDir, await freePort(), sandbox);
    checks["restart"] = { readyMs: session.readyMs, sandbox };
    const after = await fetch(`${session.origin}${historyUrl}`, { headers: { ...access, "accept-encoding": "identity" } });
    const afterBody = new Uint8Array(await after.arrayBuffer());
    check("historyContentTypeAfterRestart", after.headers.get("content-type") === "application/vnd.stats.history.v1", after.headers.get("content-type"));
    check("historySurvivesRestart", Buffer.compare(Buffer.from(afterBody), Buffer.from(beforeBody)) === 0, `bytes ${afterBody.length} vs ${beforeBody.length}`);
    check("hostListAfterRestart", (await (await fetch(`${session.origin}/api/v1/hosts`, { headers: access })).json() as { hosts: unknown[] }).hosts.length === 1);

    const tree = processTree(session.child.pid!);
    const workerd = tree.processes.filter(row => /workerd/u.test(row.command));
    check("noWorkerd", workerd.length === 0, workerd.map(row => row.command));
    checks["processes"] = tree.processes.map(row => ({ pid: row.pid, ppid: row.ppid, rssKiB: row.rssKiB, command: row.command.slice(0, 160) }));
    checks["rssKiB"] = tree.processes.reduce((total, row) => total + row.rssKiB, 0);
    await session.stop();
    session = undefined;

    check("negativeControlAckCorruption", corruptedAckThrows([0x53, 0x54, 0x41, 0x32, 0x02, 0xff, 0xff]), corruptedAckThrows([0x53, 0x54, 0x41, 0x32, 0x02, 0xff, 0xff]) ? undefined : "decodeAck accepted a corrupted acknowledgment");
    check("negativeControlHistoryCorruption", historyCorruptionThrows(beforeBody), historyCorruptionThrows(beforeBody) ? undefined : "openHistory accepted corrupted history bytes");
  } finally {
    await session?.stop().catch(() => {});
  }
  const failedCount = failures.length;
  return {
    command: "pilot",
    result: failedCount === 0 ? "pass" : "fail",
    reason: failedCount === 0 ? null : failures.join("; "),
    checks,
    failures,
    limits: {
      stateDir,
      unproven: [
        "ANALYTICS_SQL unbound on the candidate (OpenOrange has no local Analytics SQL substitute); collector pipeline unproven",
        "observation/tail delivery not yet asserted (R3); application-event path untested here",
        "Linux target and musl ABI untested (no verified Linux host in this environment)",
      ],
    },
    generated: { stats: generated.outDir },
    run: { elapsedMs: Math.round(performance.now() - started), sandbox },
  };
}

function corruptedAckThrows(bytes: readonly number[]): boolean {
  try { decodeAck(new Uint8Array(bytes), []); return false; } catch (error) { return String(error).includes("invalid acknowledgment"); }
}

function historyCorruptionThrows(bytes: Uint8Array): boolean {
  const copy = new Uint8Array(bytes);
  copy[0] = (copy[0] ?? 0) ^ 0xff;
  try { openHistory(copy); return false; } catch { return true; }
}

if (import.meta.main) {
  const runId = process.argv[2] ?? `pilot-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
  const noSandbox = process.argv.includes("--no-sandbox") || process.env.RIVET_PILOT_NO_SANDBOX === "1";
  const result = await runPilot({ runId, ...(noSandbox ? { sandbox: false } : {}) });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.result === "pass" ? 0 : result.result === "fail" ? 1 : 2;
}
