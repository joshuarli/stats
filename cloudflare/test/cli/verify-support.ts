import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { compareDeployment, comparisonBounds, DEPLOYMENT_BUCKET_MS as BUCKET, type DeploymentComparison, type MetricRow } from "../../src/deployments/compare.ts";
import type { Deployment } from "../../src/deployments/model.ts";
import type { OperationWindowRow, OperationWorkTotals } from "../../src/observe/core/store.ts";
import { createHttpClient } from "../../src/cli/http.ts";
import { createVerifyCommand } from "../../src/cli/commands/verify.ts";
import type { CommandContext } from "../../src/cli/registry.ts";
import type { SafetyRecord } from "../../src/cli/verify/decide.ts";
import { authorized, collector, deploymentHistory, fakeOrigin, observeHealth, projectEntry, sendJson, type FakeOrigin } from "./support.ts";

export const H = 3_600_000;
export const SETTLE = 45 * 60_000;
export const AT = Date.UTC(2026, 10, 2, 12, 2, 0);
export const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const bounds = comparisonBounds(AT, "1h");
export const READY_AT = bounds.after.toMs + SETTLE;
export const SCRATCH_ROOT = resolve(import.meta.dirname, "../../../.work/tmp");

export const deployment = (n: number, atMs: number, version: number, over: Partial<Deployment> = {}): Deployment => ({ id: id(n), atMs, source: "wrangler", message: null, deferred: false, versions: [{ id: id(version), percentage: 100 }], ...over });
export const PREVIOUS = deployment(1, AT - 2 * H, 101);
export const CANDIDATE = deployment(2, AT, 102);

const ZERO_WORK: OperationWorkTotals = {
  received: 0, persisted: 0, duplicate: 0, rejectedInvalidSample: 0, rejectedTooOld: 0, rejectedConflict: 0, inputBytes: 0, points: 0, cells: 0, outputBytes: 0, cacheHit304: 0, cacheRebuilt: 0,
  runs: 0, metricRows: 0, hourRollups: 0, upstreamQueries: 0, expired: 0, backlogRemaining: 0
};

export type RowOver = Partial<Omit<OperationWindowRow, "work">> & { work?: Partial<OperationWorkTotals> };

export interface World {
  clock: { now: number };
  deployments: Deployment[];
  settled: boolean;
  probes: string[];
  probeRows: MetricRow[];
  before: RowOver;
  after: RowOver;
  observedFactor: number;
  issues: Record<string, number>;
  earlierIssues: { fingerprint: string; name: string; operation: string | null; lastAtMs: number }[];
  operationRows: boolean;
  paddingRows: number;
  doRows: boolean;
  syncedAtMs: number;
}

export function newWorld(over: Partial<World> = {}): World {
  return {
    clock: { now: AT + 3 * H }, deployments: [PREVIOUS, CANDIDATE], settled: true, probes: [], probeRows: [],
    before: { rowsWritten: 600 }, after: { rowsWritten: 300 }, observedFactor: 1, issues: {}, earlierIssues: [], operationRows: true, paddingRows: 0, doRows: false, syncedAtMs: AT, ...over
  };
}

function opRows(side: "before" | "after", version: string, over: RowOver): OperationWindowRow[] {
  const { work, ...rest } = over;
  const rows: OperationWindowRow[] = [];
  for (let at = bounds[side].fromMs; at < bounds[side].toMs; at += BUCKET) {
    rows.push({
      bucketAt: at, version, operation: "host.ingest", workloadClass: "", synthetic: false, count: 20, failed: 0, cpuMsSum: 200, wallMsSum: 400, rowsRead: 40, rowsWritten: 100, statements: 80,
      lagCount: 20, lagMsMax: 100, lagMsSum: 1000, work: { ...ZERO_WORK, received: 200, persisted: 200, ...work }, ...rest
    });
  }
  return rows;
}

function analytics(doRows: boolean): MetricRow[] {
  const rows: MetricRow[] = [];
  for (const key of ["before", "after"] as const) {
    for (let at = bounds[key].fromMs; at < bounds[key].toMs; at += BUCKET) {
      rows.push({ metric: "worker.invocations", bucket_ms: at, value: 1000 }, { metric: "worker.cpuMsSum", bucket_ms: at, value: 9000 }, { metric: "route.a.invocations", bucket_ms: at, value: 1000 });
      if (doRows) rows.push({ metric: "do.invocations", bucket_ms: at, value: 1000 }, { metric: "do.cpuMsSum", bucket_ms: at, value: key === "before" ? 5000 : 2000 }, { metric: "do.wallMsSum", bucket_ms: at, value: 5000 });
    }
  }
  return rows;
}

export function comparisonOf(world: World): DeploymentComparison {
  const candidate = world.deployments.find(item => item.id === CANDIDATE.id) ?? CANDIDATE;
  return compareDeployment({
    deployment: candidate, deployments: world.deployments, rows: [...analytics(world.doRows), ...world.probeRows], window: "1h", now: world.clock.now, settleMs: SETTLE,
    lastSuccessAtMs: world.clock.now, truncated: false, enabled: true, metricsSettled: world.settled, probes: world.probes
  });
}

function windowBody(world: World, from: number, to: number, operation: string | null): unknown {
  const side = from === bounds.before.fromMs ? "before" : "after";
  const comparison = comparisonOf(world);
  const version = comparison.spec[side].versionIds[0] ?? id(0);
  const operations = world.operationRows && operation !== null ? opRows(side, version, world[side]) : [];
  const padding = operations.length === 0 ? [] : Array.from({ length: world.paddingRows }, (_, index) => ({ ...opRows(side, version, world[side])[0]!, operation: "host.history", workloadClass: `padding-${index}` }));
  const invocations: unknown[] = [];
  for (let at = from; at < to; at += BUCKET) invocations.push({ bucketAt: at, version, stage: "worker", count: Math.round(1000 * world.observedFactor) });
  return {
    fromMs: from, toMs: to, bucketMs: BUCKET, operation, workloadClass: null, filterRevision: 1, operations: [...operations, ...padding], outcomes: [], invocations,
    lag: { operations: { count: 0, maxMs: 0, sumMs: 0 }, outcomes: { count: 0, maxMs: 0, sumMs: 0 } }
  };
}

export function handler(world: World) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    if (!authorized(request)) return void response.writeHead(401).end();
    const url = new URL(request.url ?? "", "http://x");
    const { pathname, searchParams } = url;
    if (pathname === "/api/v1/capabilities") return sendJson(response, { analyticsCollection: true, cloudflareDeployments: true, tailEvents: true, applicationEvents: true });
    if (pathname === "/api/v1/projects") return sendJson(response, [projectEntry("stats", { probes: world.probes.map(name => ({ name, url: `https://x/${name}` })) })]);
    if (pathname === "/api/v1/projects/stats/deployments") return sendJson(response, deploymentHistory("stats", { deployments: world.deployments, sync: { lastAttemptAtMs: world.syncedAtMs, lastSuccessAtMs: world.syncedAtMs, error: null, truncated: false } }));
    const compared = /^\/api\/v1\/projects\/stats\/deployments\/([^/]+)\/comparison$/u.exec(pathname);
    if (compared !== null) return world.deployments.some(item => item.id === compared[1]) ? sendJson(response, comparisonOf(world)) : void response.writeHead(404).end();
    if (pathname === "/api/observe/stats/health") return sendJson(response, observeHealth(world.clock.now - 60_000));
    if (pathname === "/api/observe/stats/window") return sendJson(response, windowBody(world, Number(searchParams.get("from")), Number(searchParams.get("to")), searchParams.get("operation")));
    if (pathname === "/api/observe/stats/issues") {
      const introducedIn = searchParams.get("introducedIn");
      const groups = world.issues[introducedIn ?? ""] ?? 0;
      const issue = (fields: { fingerprint: string; name: string; operation: string | null; lastAtMs: number }, firstVersion: string | null) => ({ frame: null, state: "open", occurrences: 3, firstAtMs: AT, lastVersion: null, versions: 1, firstVersion, firstVersionLabel: null, ...fields });
      const items = introducedIn === null
        ? world.earlierIssues.map(fields => issue(fields, id(101)))
        : Array.from({ length: groups }, (_, index) => issue({ fingerprint: `f${index}`, name: "Error", operation: null, lastAtMs: AT }, introducedIn));
      return sendJson(response, { items, next: null });
    }
    response.writeHead(404).end();
  };
}

export const POLICY = {
  schema: "statsctl-policy/1", id: "ingest-rows", hypothesis: "Fewer index updates cut rows written per persisted sample.", project: "stats", operation: "host.ingest", metric: "rowsWrittenPerUnit", direction: "decrease",
  minChangePercent: 10, floor: 0.5, guardrails: ["safety-check", "failed-share", "new-issue-group", "probe-failure-share", "coverage", "ingest-persistence"], window: "1h", maxWaitMs: 48 * H
};

export const GOOD_SAFETY: SafetyRecord = { ok: true, atMs: AT + 60_000, hostId: "h_0", origin: "http://x", failedStep: null, file: "check.json" };

export interface Harness {
  readonly origin: FakeOrigin;
  readonly world: World;
  readonly directory: string;
  readonly policyFile: string;
  readonly sleeps: number[];
  run(options: Record<string, string | boolean>, extra?: { onSleep?: (ms: number) => void; signal?: AbortSignal }): ReturnType<ReturnType<typeof createVerifyCommand>["execute"]>;
  safetyFile(record: Partial<SafetyRecord>, origin?: string): string;
  close(): Promise<void>;
}

export async function harness(world: World, policy: Record<string, unknown> = POLICY): Promise<Harness> {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const directory = mkdtempSync(join(SCRATCH_ROOT, "verify-"));
  const policyFile = join(directory, "policy.json");
  writeFileSync(policyFile, JSON.stringify(policy));
  const origin = await fakeOrigin(handler(world));
  const sleeps: number[] = [];
  let files = 0;
  return {
    origin, world, directory, policyFile, sleeps,
    safetyFile(record, document = origin.origin) {
      const file = join(directory, `check-${files += 1}.json`);
      const merged = { ...GOOD_SAFETY, ...record };
      writeFileSync(file, JSON.stringify({ schema: "statsctl/1", command: "check ingest", origin: document, payload: { ok: merged.ok, hostId: merged.hostId, seq: "1", atMs: merged.atMs, steps: [{ name: "encode", ok: true }, ...(merged.ok ? [] : [{ name: merged.failedStep ?? "replay", ok: false }])] } }));
      return file;
    },
    run(options, extra = {}) {
      const controller = new AbortController();
      const signal = extra.signal ?? controller.signal;
      const sleep = async (ms: number, aborter: AbortSignal): Promise<boolean> => {
        sleeps.push(ms);
        extra.onSleep?.(ms);
        if (aborter.aborted) return false;
        world.clock.now += ms;
        return true;
      };
      const command = createVerifyCommand({ sleep, stateDirectory: join(directory, "state") });
      const values: Record<string, string | boolean> = options["replay"] === undefined ? { project: "stats", policy: policyFile, ...options } : options;
      const context: CommandContext = {
        origin: origin.origin, target: "orange", signal, now: () => world.clock.now,
        http: createHttpClient({ origin: origin.origin, signal, backoffMs: 0 }),
        option: name => typeof values[name] === "string" ? values[name] : undefined,
        flag: name => values[name] === true
      };
      return command.execute(context);
    },
    close: () => origin.close()
  };
}

export { collector };
