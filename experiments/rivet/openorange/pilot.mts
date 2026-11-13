import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { decodeAck } from "../../../cloudflare/src/ingest/ack-decode.ts";
import { openHistory } from "../../../cloudflare/src/binary/history.ts";
import { INGEST_MEDIA_TYPE } from "../../../cloudflare/src/ingest/http.ts";
import { encodeFrame } from "../../../cloudflare/src/ingest/encode.ts";
import { fixtureBytes, fixtureSource, manifest, withHost } from "../../../cloudflare/test/node/support.ts";
import { accessToken } from "../../../cloudflare/test/access-token.ts";
import { BIN, EXPERIMENTS, freePort, historyFingerprint, processTree, startSession, waitForHttp, generate, ROOT, OFFLINE, type Session } from "./harness.mts";

const HOST_INGEST_TYPE = INGEST_MEDIA_TYPE;

export interface PilotOptions {
  readonly runId: string;
  readonly sandbox?: boolean;
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
    session = undefined;

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
