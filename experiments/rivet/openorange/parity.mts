import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { INGEST_MEDIA_TYPE } from "../../../cloudflare/src/ingest/http.ts";
import { encodeFrame } from "../../../cloudflare/src/ingest/encode.ts";
import { HISTORY_KINDS } from "../../../cloudflare/src/limits.ts";
import { fixtureBytes, fixtureSource, manifest, openHarness, withHost } from "../../../cloudflare/test/node/support.ts";
import { accessToken } from "../../../cloudflare/test/access-token.ts";
import { BIN, EXPERIMENTS, freePort, historyFingerprint, processTree, startSession, waitForHttp, generate, ROOT, OFFLINE, type Session } from "./harness.mts";

export interface ParityOptions { readonly runId: string; readonly sandbox?: boolean }

const RANGES = ["1h", "6h", "24h", "7d", "30d"] as const;

type Harness = ReturnType<typeof openHarness>;

interface Check { (name: string, ok: boolean, detail?: unknown): void }
interface Accumulator { readonly checks: Record<string, unknown>; readonly failures: string[]; readonly check: Check }

function accumulate(): Accumulator {
  const checks: Record<string, unknown> = {};
  const failures: string[] = [];
  const check: Check = (name, ok, detail) => { const prepared = detail === undefined ? undefined : JSON.parse(JSON.stringify(detail, (_key, value) => typeof value === "bigint" ? value.toString() : value)) as unknown; checks[name] = prepared === undefined ? ok : { ok, detail: prepared }; if (!ok) failures.push(`${name}: ${prepared === undefined || typeof prepared === "string" ? String(prepared ?? "") : JSON.stringify(prepared)}`); };
  return { checks, failures, check };
}

interface Observed { readonly status: number; readonly contentType: string | null; readonly etag: string | null; readonly body: string }

async function observe(response: Response): Promise<Observed> {
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    etag: response.headers.get("etag"),
    body: Array.from(new Uint8Array(await response.arrayBuffer()), byte => byte.toString(16).padStart(2, "0")).join(""),
  };
}

const eq = (left: Observed, right: Observed): boolean => left.status === right.status && left.contentType === right.contentType && left.etag === right.etag && left.body === right.body;

const INGEST_TYPE = INGEST_MEDIA_TYPE;
const candidateIngest = async (origin: string, token: string, frame: Uint8Array): Promise<Observed> => observe(await fetch(`${origin}/ingest/v2/batches`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": INGEST_TYPE }, body: frame.slice() }));
const controlIngest = async (node: Harness, token: string, frame: Uint8Array): Promise<Observed> => observe(await node.core.fetch(new Request("https://installation/ingest", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": INGEST_TYPE }, body: frame.slice() })));

async function createHost(origin: string, access: Record<string, string>, name: string): Promise<{ hostId: string; token: string }> {
  const response = await fetch(`${origin}/api/v1/admin/hosts`, { method: "POST", headers: { ...access, "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  if (response.status !== 201) throw new Error(`createHost ${name} returned ${response.status}: ${await response.text()}`);
  return await response.json() as { hostId: string; token: string };
}

async function compareFixtureCorpus(origin: string, access: Record<string, string>, node: Harness, acc: Accumulator): Promise<{ linuxHost: { hostId: string; token: string } }> {
  let linuxHost: { hostId: string; token: string } | undefined;
  for (const entry of manifest.batches) {
    const host = await createHost(origin, access, entry.name);
    await node.adoptHost(host.hostId, host.token, entry.name);
    const frame = withHost(fixtureBytes(entry.frame), host.hostId);
    for (const attempt of ["first", "replay"] as const) {
      const fromCandidate = await candidateIngest(origin, host.token, frame);
      const fromControl = await controlIngest(node, host.token, frame);
      acc.check(`ingest:${entry.name}:${attempt}`, eq(fromControl, fromCandidate), { control: fromControl.status, candidate: fromCandidate.status });
    }
    for (const range of RANGES) {
      for (const kind of HISTORY_KINDS) {
        const search = `range=${range}&kind=${kind}`;
        const fromCandidate = await observe(await fetch(`${origin}/api/v1/hosts/${host.hostId}/history?${search}`, { headers: { ...access, "accept-encoding": "identity" } }));
        const fromControl = await observe(await node.core.fetch(new Request(`https://installation/hosts/${host.hostId}/history?${search}`, { headers: { "accept-encoding": "identity" } })));
        acc.check(`history:${entry.name}:${search}`, eq(fromControl, fromCandidate), { control: fromControl.status, candidate: fromCandidate.status });
      }
      const bundle = `range=${range}&kinds=${HISTORY_KINDS.join("+")}`;
      const fromCandidate = await observe(await fetch(`${origin}/api/v1/hosts/${host.hostId}/history?${bundle}`, { headers: { ...access, "accept-encoding": "identity" } }));
      const fromControl = await observe(await node.core.fetch(new Request(`https://installation/hosts/${host.hostId}/history?${bundle}`, { headers: { "accept-encoding": "identity" } })));
      acc.check(`history:${entry.name}:${bundle}`, eq(fromControl, fromCandidate), { control: fromControl.status, candidate: fromCandidate.status });
    }
    for (const suffix of ["latest", "system"] as const) {
      const fromCandidate = await observe(await fetch(`${origin}/api/v1/hosts/${host.hostId}/${suffix}`, { headers: access }));
      const fromControl = await observe(await node.core.fetch(new Request(`https://installation/hosts/${host.hostId}/${suffix}`)));
      acc.check(`${suffix}:${entry.name}`, eq(fromControl, fromCandidate), { control: fromControl.status, candidate: fromCandidate.status });
    }
    if (entry.name === "linux-normal") linuxHost = host;
  }
  const candidateList = await observe(await fetch(`${origin}/api/v1/hosts`, { headers: access }));
  const controlList = await observe(await node.core.fetch(new Request("https://installation/hosts")));
  acc.check("hostList", eq(controlList, candidateList), { control: controlList.status, candidate: candidateList.status });
  return { linuxHost: linuxHost! };
}

async function compareMalformedCorpus(origin: string, node: Harness, acc: Accumulator): Promise<void> {
  const cases = (JSON.parse(readFileSync(join(ROOT, "fixtures/v2/malformed.json"), "utf8")) as { cases: { name: string; code: string; hex: string }[] }).cases;
  for (const entry of cases) {
    const body = Uint8Array.from(Buffer.from(entry.hex, "hex"));
    const fromCandidate = await observe(await fetch(`${origin}/ingest/v2/batches`, { method: "POST", headers: { Authorization: "Bearer nft_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "Content-Type": INGEST_TYPE }, body: body.slice() }));
    const fromControl = await observe(await node.core.fetch(new Request("https://installation/ingest", { method: "POST", headers: { Authorization: "Bearer nft_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "Content-Type": INGEST_TYPE }, body: body.slice() })));
    acc.check(`malformed:${entry.name}`, eq(fromControl, fromCandidate), { control: fromControl.status, candidate: fromCandidate.status });
  }
}

async function historyEtagAndInvalidation(origin: string, access: Record<string, string>, linuxHost: { hostId: string; token: string }, acc: Accumulator): Promise<void> {
  const url = `/api/v1/hosts/${linuxHost.hostId}/history?range=24h&kind=summary`;
  const before = await observe(await fetch(`${origin}${url}`, { headers: { ...access, "accept-encoding": "identity" } }));
  const notModified = await fetch(`${origin}${url}`, { headers: { ...access, "If-None-Match": before.etag ?? "" } });
  acc.check("historyEtagRoundTrip", before.etag !== null && notModified.status === 304, { etag: before.etag, status: notModified.status });
  const base = fixtureSource("sources/linux-normal.json");
  const mutated = { ...base, samples: base.samples.map(sample => ({ ...sample, seq: String(BigInt(String((sample as { seq: unknown }).seq)) + 60n), monoMs: String(Number((sample as { monoMs: unknown }).monoMs) + 60_000), atMs: String(Number((sample as { atMs: unknown }).atMs) + 60_000) })) };
  const advanced = await candidateIngest(origin, linuxHost.token, withHost(encodeFrame(mutated), linuxHost.hostId));
  const after = await observe(await fetch(`${origin}${url}`, { headers: { ...access, "If-None-Match": before.etag ?? "", "accept-encoding": "identity" } }));
  acc.check("cacheInvalidatesAfterMutation", advanced.status === 200 && after.status === 200 && after.etag !== before.etag, { afterMutation: after.status, etagChanged: after.etag !== before.etag });
  // malformed frame for r2 invalidation check: covered by corpus replay
}

async function conflictingRetry(origin: string, node: Harness, linuxHost: { hostId: string; token: string }, acc: Accumulator): Promise<void> {
  const base = fixtureSource("sources/linux-normal.json");
  const conflictSource = { ...base, samples: base.samples.map(sample => ({ ...sample, cpu: { ...(sample.cpu as Record<string, unknown>), total: "999999999999" } })) };
  const conflictFrame = withHost(encodeFrame(conflictSource), linuxHost.hostId);
  const fromCandidate = await candidateIngest(origin, linuxHost.token, conflictFrame);
  const fromControl = await controlIngest(node, linuxHost.token, conflictFrame);
  acc.check("conflictingRetry", fromCandidate.status === 400 && eq(fromControl, fromCandidate), { control: fromControl.status, candidate: fromCandidate.status });
  const goldenDuplicates = fixtureBytes("frames/acks/all-duplicates.sta2");
  const replay = await candidateIngest(origin, linuxHost.token, withHost(fixtureBytes("frames/linux-normal.stb2"), linuxHost.hostId));
  acc.check("replayMatchesGoldenAck", replay.status === 200 && replay.body === Array.from(goldenDuplicates, byte => byte.toString(16).padStart(2, "0")).join(""), { status: replay.status });
}

export async function runParity(options: ParityOptions): Promise<Record<string, unknown>> {
  const acc = accumulate();
  const bootstrap = existsSync(BIN) && existsSync(join(EXPERIMENTS, "package.json")) && existsSync(join(EXPERIMENTS, "pnpm-lock.yaml"));
  if (!bootstrap) return { command: "parity", result: "blocked", reason: "candidate bootstrap missing; run node scripts/rivet-eval.mjs bootstrap", checks: acc.checks, failures: acc.failures };
  if (options.sandbox === true && process.platform !== "darwin") return { command: "parity", result: "blocked", reason: "OS-enforced network sandbox is macOS-only (scripts/offline-run.sh)", checks: acc.checks, failures: acc.failures };
  if (options.sandbox === undefined && process.platform !== "darwin") return { command: "parity", result: "blocked", reason: "parity is verified under the macOS offline sandbox; on this host rerun with --no-sandbox and record the limitation", checks: acc.checks, failures: acc.failures };
  const { ensureBuilds } = await import("../../../cloudflare/scripts/ensure-build.ts");
  await ensureBuilds(["stats", "observe"], { signal: new AbortController().signal });
  const sandbox = options.sandbox ?? true;
  const runRoot = join(ROOT, ".work/rivet-eval", options.runId, "parity");
  rmSync(runRoot, { recursive: true, force: true });
  mkdirSync(runRoot, { recursive: true });
  const stateDir = join(runRoot, "state");
  generate({ outDir: stateDir });
  const access = { "cf-access-jwt-assertion": await accessToken() };
  const node = openHarness("[]");
  let session: Session | undefined;
  const started = performance.now();
  try {
    session = await startSession(stateDir, await freePort(), sandbox);
    acc.checks["startup"] = { readyMs: session.readyMs, sandbox, origin: session.origin };
    const health = await waitForHttp(session.origin, "/health", {});
    acc.check("health", health.status === 200, `status ${health.status}`);
    const denied = await fetch(`${session.origin}/api/v1/hosts`);
    acc.check("authRejectsMissingJwt", denied.status === 401, `status ${denied.status}`);
    const badJwt = await fetch(`${session.origin}/api/v1/hosts`, { headers: { "cf-access-jwt-assertion": "not-a-jwt" } });
    acc.check("authRejectsBadJwt", badJwt.status === 401, `status ${badJwt.status}`);
    const { linuxHost } = await compareFixtureCorpus(session.origin, access, node, acc);
    await compareMalformedCorpus(session.origin, node, acc);
    await conflictingRetry(session.origin, node, linuxHost, acc);
    await historyEtagAndInvalidation(session.origin, access, linuxHost, acc);

    const beforeRestart = new Uint8Array(await (await fetch(`${session.origin}/api/v1/hosts/${linuxHost.hostId}/history?range=24h&kind=summary`, { headers: { ...access, "accept-encoding": "identity" } })).arrayBuffer());
    await session.stop();
    session = undefined;

    session = await startSession(stateDir, await freePort(), sandbox);
    acc.checks["restart"] = { readyMs: session.readyMs, sandbox };
    const afterRestart = new Uint8Array(await (await fetch(`${session.origin}/api/v1/hosts/${linuxHost.hostId}/history?range=24h&kind=summary`, { headers: { ...access, "accept-encoding": "identity" } })).arrayBuffer());
    acc.check("historySurvivesRestart", Buffer.compare(Buffer.from(afterRestart), Buffer.from(beforeRestart)) === 0, { bytes: afterRestart.byteLength });
    const hostList = await fetch(`${session.origin}/api/v1/hosts`, { headers: access });
    acc.check("hostListAfterRestart", hostList.status === 200 && (await hostList.json() as { hosts: unknown[] }).hosts.length === manifest.batches.length, `status ${hostList.status}`);
    await session.stop();
    session = undefined;
  } finally {
    node.close();
    await session?.stop().catch(() => {});
  }

  try {
    await runRealTimeChecks(acc, sandbox, runRoot);
  } catch (error) {
    acc.check("realTimeSession", false, String(error instanceof Error ? error.message : error).slice(0, 400));
  }

  const failedCount = acc.failures.length;
  return {
    command: "parity",
    result: failedCount === 0 ? "pass" : "fail",
    reason: failedCount === 0 ? null : acc.failures.join("; "),
    checks: acc.checks,
    failures: acc.failures,
    limits: {
      stateDir: runRoot,
      unproven: [
        "ANALYTICS_SQL unbound on the candidate (OpenOrange has no local Analytics SQL substitute); collector pipeline unproven",
        "DO storage.setAlarm delivery (installation cleanup alarm, >=10 real minutes) not exercised in this slice",
        "diagnostics-channel error reports are dropped by the platform tail (diagnosticsChannelEvents: []); failures surface as invocation exceptions instead",
        "Linux target and musl ABIs untested (no verified Linux host in this environment)",
      ],
    },
    run: { elapsedMs: Math.round(performance.now() - started), sandbox },
  };
}

async function runRealTimeChecks(acc: Accumulator, sandbox: boolean, runRoot: string): Promise<void> {
  const realStateDir = join(runRoot, "state-real-time");
  generate({ outDir: realStateDir, testNowMs: null });
  const access = { "cf-access-jwt-assertion": await accessToken() };
  let session: Session | undefined;
  try {
    session = await startSession(realStateDir, await freePort(), sandbox);
    acc.checks["realTimeStartup"] = { readyMs: session.readyMs, sandbox };
    const realNow = Date.now();
    const realHost = await createHost(session.origin, access, "synthetic-check-parity");
    const credentialPath = join(runRoot, "synthetic-check-credential.json");
    writeFileSync(credentialPath, JSON.stringify({ hostId: realHost.hostId, token: realHost.token }));
    chmodSync(credentialPath, 0o600);
    const jwtPath = join(runRoot, "access-jwt.txt");
    writeFileSync(jwtPath, await accessToken());
    chmodSync(jwtPath, 0o600);
    let cliOk = false;
    let cliFailure: string | undefined;
    try {
      const out = execFileSync(process.execPath, ["--experimental-strip-types", join(ROOT, "cloudflare/src/cli/statsctl.ts"), "check", "ingest", "--credential-file", credentialPath, "--origin", session.origin, "--json"], { encoding: "utf8", env: { ...process.env, STATSCTL_AUTH_COMMAND: `cat ${jwtPath}`, STATSCTL_AUTH_HEADER: "cf-access-jwt-assertion" }, timeout: 90_000, maxBuffer: 16 * 1024 * 1024 });
      const envelope = JSON.parse(out) as { payload?: { ok?: boolean }; error?: { code?: string; message?: string } };
      cliOk = envelope.payload?.ok === true;
      cliFailure = envelope.error ? `${envelope.error.code}: ${envelope.error.message ?? ""}` : (cliOk ? undefined : "payload reported not ok");
    } catch (error) { cliFailure = String(error instanceof Error ? error.message : error).slice(0, 400); }
    acc.check("cliCheckIngest", cliOk, cliFailure);

    const producerHostResp = await fetch(`${session.origin}/api/v1/admin/hosts`, { method: "POST", headers: { ...access, "Content-Type": "application/json" }, body: JSON.stringify({ name: "producer-probe" }) });
    const producerHost = await producerHostResp.json() as { hostId: string };
    const serviceResp = await fetch(`${session.origin}/api/v1/admin/services`, { method: "POST", headers: { ...access, "Content-Type": "application/json" }, body: JSON.stringify({ name: "tansu-parity", hostIds: [producerHost.hostId] }) });
    const service = await serviceResp.json() as { ingestToken: string; deployToken: string };
    acc.check("serviceProvision", serviceResp.status === 201, `status ${serviceResp.status}`);
    const golden = JSON.parse(readFileSync(join(ROOT, "fixtures/observe-ingest/golden.json"), "utf8")) as { events: readonly Record<string, unknown>[] };
    const manifestObserve = JSON.parse(readFileSync(join(ROOT, "fixtures/observe-ingest/manifest.json"), "utf8")) as { nowMs: number };
    const { decodeBatch } = await import("../../../cloudflare/src/observe/ingest/codec.ts");
    const decoded = decodeBatch(JSON.stringify(golden), { service: "tansu", nowMs: manifestObserve.nowMs });
    if (!decoded.ok) throw new Error(`golden observe-ingest batch failed to decode: ${decoded.message}`);
    const events = decoded.batch.events.map((event, index) => ({ ...event, service: "tansu-parity", atMs: realNow - 120_000 + index * 60_000 }));
    const producerBody = JSON.stringify({ events });
    const first = await fetch(`${session.origin}/ingest/observe/v1/tansu-parity/batches`, { method: "POST", headers: { authorization: `Bearer ${service.ingestToken}`, "content-type": "application/json" }, body: producerBody });
    const firstBody = await first.json() as { accepted?: number };
    const replayProducer = await fetch(`${session.origin}/ingest/observe/v1/tansu-parity/batches`, { method: "POST", headers: { authorization: `Bearer ${service.ingestToken}`, "content-type": "application/json" }, body: producerBody });
    const replayProducerBody = await replayProducer.json() as { duplicate?: number };
    acc.check("producerIdempotency", first.status === 202 && firstBody.accepted === 2 && replayProducer.status === 200 && replayProducerBody.duplicate === 2, { first: first.status, replay: replayProducer.status, accepted: firstBody.accepted, duplicate: replayProducerBody.duplicate });

    const marker = { markerId: "v-9.9.9", version: "9.9.9", message: "release 9.9.9", hostIds: [producerHost.hostId] };
    const markerFirst = await fetch(`${session.origin}/ingest/services/tansu-parity/deployments`, { method: "POST", headers: { authorization: `Bearer ${service.deployToken}`, "content-type": "application/json" }, body: JSON.stringify(marker) });
    const markerFirstBody = await markerFirst.json() as { deployment?: { id?: string } };
    const markerReplay = await fetch(`${session.origin}/ingest/services/tansu-parity/deployments`, { method: "POST", headers: { authorization: `Bearer ${service.deployToken}`, "content-type": "application/json" }, body: JSON.stringify(marker) });
    const markerReplayBody = await markerReplay.json() as { deployment?: { id?: string } };
    acc.check("deploymentMarkerIdempotency", markerFirst.status === 201 && markerReplay.status === 200 && markerFirstBody.deployment?.id !== undefined && markerReplayBody.deployment?.id === markerFirstBody.deployment.id, { first: markerFirst.status, replay: markerReplay.status });

    const root = await fetch(`${session.origin}/`, { headers: access });
    const rootBody = await root.text();
    acc.check("dashboardServesWithAuth", root.status === 200 && rootBody.includes("<html"), { status: root.status });
    const unauth = await fetch(`${session.origin}/`);
    acc.check("dashboardProtectedWithoutAuth", unauth.status === 401, `status ${unauth.status}`);

    await new Promise(resolveWait => setTimeout(resolveWait, 2000));
    const external = await fetch(`${session.origin}/api/observe/stats/external?from=${realNow - 600_000}&to=${realNow + 600_000}&limit=20`, { headers: access });
    const externalBody = await external.json() as { events?: { provenance?: string; service?: string; event?: { operation?: string; release?: string; service?: string } }[] };
    const applicationEvents = (externalBody.events ?? []).filter(entry => entry.provenance === "application" && entry.service === "stats");
    const released = applicationEvents.filter(entry => entry.event?.release?.startsWith("stats-eval-") === true);
    acc.check("applicationEventsVisible", applicationEvents.length > 0 && released.length > 0, { applicationEvents: applicationEvents.length, withRelease: released.length, operations: applicationEvents.map(entry => entry.event?.operation) });
    const healthObserve = await fetch(`${session.origin}/api/observe/stats/health`, { headers: access });
    const observeHealth = await healthObserve.json() as { liveInvocations?: number; writes?: { ingestBatches?: number } };
    acc.check("observePipelineAlive", healthObserve.status === 200 && (observeHealth.liveInvocations ?? 0) > 0, { status: healthObserve.status, liveInvocations: observeHealth.liveInvocations, ingestBatches: observeHealth.writes?.ingestBatches });

    const tree = processTree(session.child.pid!);
    const workerd = tree.processes.filter(row => /workerd/u.test(row.command));
    acc.check("noWorkerd", workerd.length === 0, workerd.map(row => row.command));
    acc.checks["processes"] = tree.processes.map(row => ({ pid: row.pid, ppid: row.ppid, rssKiB: row.rssKiB, command: row.command.slice(0, 160) }));
    acc.checks["rssKiB"] = tree.processes.reduce((total, row) => total + row.rssKiB, 0);
  } finally {
    await session?.stop().catch(() => {});
  }
}

if (import.meta.main) {
  const runId = process.argv[2] ?? `parity-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
  const noSandbox = process.argv.includes("--no-sandbox") || process.env.RIVET_PILOT_NO_SANDBOX === "1";
  const result = await runParity({ runId, ...(noSandbox ? { sandbox: false } : {}) });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.result === "pass" ? 0 : result.result === "fail" ? 1 : 2;
}
