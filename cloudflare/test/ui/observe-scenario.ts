import { DatabaseSync } from "node:sqlite";
import { prepareInvocation, prepareRollout, type ObservedError, type ObservedInvocation, type Preparation, type PreparedInvocation } from "../../src/observe/core/model.ts";
import { ingest, initializeStore, listIssues, recordRollouts, setIssueState, type SqlDatabase } from "../../src/observe/core/store.ts";
import { wrap } from "../observe/support.ts";
import { createObserveService, type ObserveService } from "../../src/observe/core/service.ts";
import { encode, type SourceMapSegment } from "@jridgewell/sourcemap-codec";
import { handleApi } from "../../src/observe/http/api.ts";
import type { DeploymentHistory } from "../../src/deployments/model.ts";

const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;
const OBJECT = "a3f9c1e2b4d6f8a0c2e4f6a8b0d2f4e6a8c0e2f4a6b8d0f2e4a6c8e0f2a4b6c8";

export const SCENARIO_ROLLOUTS = {
  v12: "0a1b2c3d-1111-4a5b-8c6d-000000000012",
  canary: "0a1b2c3d-1111-4a5b-8c6d-000000000013",
  v13: "0a1b2c3d-1111-4a5b-8c6d-000000000113",
  v14: "0a1b2c3d-1111-4a5b-8c6d-000000000014"
} as const;

export const SCENARIO_VERSIONS = [
  { id: "5d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6", tag: "v1.2.0", message: "Batch ingest validation" },
  { id: "6e2f3a4b-5c6d-4e7f-9081-92b3c4d5e6f7", tag: "v1.3.0", message: "Project config parser" },
  { id: "7f3a4b5c-6d7e-4f80-a192-a3c4d5e6f708", tag: "v1.4.0", message: "Faster hour rollups" }
] as const;
const [V12, V13, V14] = SCENARIO_VERSIONS;

interface Rollout { readonly id: string; readonly at: number; readonly message: string; readonly shares: readonly { readonly version: string; readonly percent: number }[] }

function rollouts(now: number): Rollout[] {
  return [
    { id: SCENARIO_ROLLOUTS.v12, at: now - 6.5 * D, message: V12.message, shares: [{ version: V12.id, percent: 100 }] },
    { id: SCENARIO_ROLLOUTS.canary, at: now - 3 * D, message: "v1.3.0 canary", shares: [{ version: V12.id, percent: 90 }, { version: V13.id, percent: 10 }] },
    { id: SCENARIO_ROLLOUTS.v13, at: now - 2.8 * D, message: V13.message, shares: [{ version: V13.id, percent: 100 }] },
    { id: SCENARIO_ROLLOUTS.v14, at: now - 9 * H, message: V14.message, shares: [{ version: V14.id, percent: 100 }] }
  ];
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lognormal(next: () => number, median: number, sigma: number): number {
  const normal = Math.sqrt(-2 * Math.log(Math.max(next(), 1e-12))) * Math.cos(2 * Math.PI * next());
  return median * Math.exp(sigma * normal);
}

function stack(version: string, frames: readonly (readonly [string, number])[]): string {
  const shift = shiftFor(version);
  return frames.map(([fn, line]) => `    at ${fn} (index.js:${line + shift}:${(line * 7) % 40 + 3})`).join("\n");
}

const REBUILD = [["rebuildHour", 2410], ["rebuildRollups", 2431], ["ingest", 2687], ["Installation.fetch", 2752]] as const;
const PARSE = [["parseProjects", 1188], ["projectRegistry", 2511], ["projectList", 2520], ["Installation.fetch", 2752]] as const;
const POLL = [["request", 3121], ["collectProject", 3150], ["collectDeployments", 3204], ["scheduled", 3388]] as const;
const ORIGINS: Record<string, readonly [string, number]> = {
  rebuildHour: ["src/installation.ts", 419], rebuildRollups: ["src/installation.ts", 427], ingest: ["src/installation.ts", 642], "Installation.fetch": ["src/installation.ts", 680],
  parseProjects: ["src/projects/config.ts", 41], projectRegistry: ["src/installation.ts", 487], projectList: ["src/installation.ts", 496],
  request: ["src/deployments/collector.ts", 58], collectProject: ["src/deployments/collector.ts", 81], collectDeployments: ["src/deployments/collector.ts", 131], scheduled: ["src/index.ts", 117]
};

function shiftFor(version: string): number {
  return version === V14.id ? 37 : version === V13.id ? 12 : 0;
}

function bundleMap(version: string): string {
  const sources = [...new Set(Object.values(ORIGINS).map(([file]) => file))];
  const names = Object.keys(ORIGINS);
  const lines: SourceMapSegment[][] = [];
  for (const [fn, line] of [...REBUILD, ...PARSE, ...POLL]) {
    const generated = line + shiftFor(version) - 1;
    const [file, originalLine] = ORIGINS[fn]!;
    while (lines.length <= generated) lines.push([]);
    lines[generated] = [[(line * 7) % 40 + 2, sources.indexOf(file), originalLine - 1, 2, names.indexOf(fn)]];
  }
  return JSON.stringify({ version: 3, file: "index.js", sources: sources.map(file => `../../../../../../${file}`), names, mappings: encode(lines) });
}

export interface Scenario {
  readonly db: SqlDatabase;
  readonly deployments: DeploymentHistory;
  readonly invocations: number;
}

export async function buildScenario(now: number): Promise<Scenario> {
  const raw = new DatabaseSync(":memory:");
  const db: SqlDatabase = wrap(raw);
  initializeStore(db);
  const next = random(20261104);
  const plan = rollouts(now);
  const start = now - 7 * D + H;
  const versionAt = (at: number): string => {
    const active = [...plan].reverse().find(rollout => rollout.at <= at) ?? plan[0]!;
    let pick = next() * 100;
    for (const share of active.shares) { pick -= share.percent; if (pick <= 0) return share.version; }
    return active.shares.at(-1)!.version;
  };
  recordRollouts(db, await Promise.all(plan.map(rollout => prepareRollout({ id: rollout.id, atMs: rollout.at, source: "wrangler", message: rollout.message, shares: rollout.shares }))),
    SCENARIO_VERSIONS.map(version => ({ version: version.id, label: version.tag, message: version.message })), now);

  const id = (width: number) => Array.from({ length: width }, () => Math.floor(next() * 16).toString(16)).join("");
  const pending: Preparation[] = [];
  const plain = (fields: Omit<ObservedInvocation, "errors" | "trace" | "objectId"> & { trace: string; objectId?: string }): Preparation => {
    const span = id(16);
    const invocation: PreparedInvocation = {
      key: span, digest: span, version: fields.version, stage: fields.stage, objectId: fields.objectId ?? null, kind: fields.kind, label: fields.label, status: fields.status,
      outcome: fields.outcome, cpuMs: fields.cpuMs, wallMs: fields.wallMs, eventAtMs: fields.eventAtMs, trace: { traceId: fields.trace, spanId: span }, errorCount: 0, errors: [], keySource: "span"
    };
    return { ok: true, invocation };
  };
  const failing = async (fields: Omit<ObservedInvocation, "trace" | "objectId"> & { trace: string; objectId?: string }) =>
    prepareInvocation({ ...fields, objectId: fields.objectId ?? null, trace: { traceId: fields.trace, spanId: id(16) } }, { safeNames: new Set() });

  const request = async (label: string, objectLabel: string, at: number, cpu: { median: number; sigma: number }, fault: ((version: string) => "uncaught" | "caught" | null) | null) => {
    const version = versionAt(at);
    const trace = id(32);
    const hot = label.includes("hosts/:host/history") && version === V14.id && next() < 0.35;
    const objectCpu = Math.max(1, Math.round(lognormal(next, cpu.median, cpu.sigma) * (hot ? 3.2 : 1)));
    const objectWall = Math.max(objectCpu + 2, Math.round(objectCpu * 1.25 + lognormal(next, 14, 0.4)));
    const offset = Math.round(lognormal(next, 9, 0.3));
    const workerWall = offset + objectWall + Math.round(lognormal(next, 12, 0.5));
    const kind = fault?.(version) ?? null;
    const base = { version, kind: "fetch" as const, eventAtMs: at };
    if (kind === "uncaught") {
      const error: ObservedError = { source: "uncaught", operation: null, name: "TypeError", message: "Cannot read properties of undefined (reading 'buckets')", stack: stack(version, PARSE) };
      pending.push(await failing({ ...base, trace, stage: "object", objectId: OBJECT, label: objectLabel, status: null, outcome: "exception", cpuMs: objectCpu, wallMs: objectWall, eventAtMs: at + offset, errors: [error] }));
      pending.push(await failing({ ...base, trace, stage: "worker", label, status: 500, outcome: "exception", cpuMs: 1, wallMs: workerWall, errors: [{ ...error, stack: null }] }));
      return;
    }
    if (kind === "caught") {
      const error: ObservedError = { source: "caught", operation: "installation.request", name: "RangeError", message: "Invalid array length", stack: stack(version, REBUILD) };
      pending.push(await failing({ ...base, trace, stage: "object", objectId: OBJECT, label: objectLabel, status: 500, outcome: "ok", cpuMs: objectCpu, wallMs: objectWall, eventAtMs: at + offset, errors: [error] }));
      pending.push(plain({ ...base, trace, stage: "worker", label, status: 500, outcome: "ok", cpuMs: 1, wallMs: workerWall }));
      return;
    }
    pending.push(plain({ ...base, trace, stage: "object", objectId: OBJECT, label: objectLabel, status: 200, outcome: "ok", cpuMs: objectCpu, wallMs: objectWall, eventAtMs: at + offset }));
    pending.push(plain({ ...base, trace, stage: "worker", label, status: 200, outcome: "ok", cpuMs: Math.round(lognormal(next, 1.2, 0.4)), wallMs: workerWall }));
  };

  const scheduled = async (at: number) => {
    const version = versionAt(at);
    const trace = id(32);
    const wall = Math.round(lognormal(next, 1800, 0.15));
    const pollFails = next() < 0.03;
    const steps: [string, number, number, number][] = [["Installation.knownDeploymentVersions", 0.22, 7, 1], ["Installation.recordDeploymentPoll", 0.82, 11, 2], ["Installation.recordCollectorRun", 0.97, 45, 27]];
    for (const [stepLabel, fraction, stepWall, stepCpu] of steps) {
      pending.push(plain({ version, trace, stage: "object", objectId: OBJECT, kind: "rpc", label: stepLabel, status: null, outcome: "ok", cpuMs: Math.round(lognormal(next, stepCpu, 0.3)), wallMs: Math.round(lognormal(next, stepWall, 0.3)), eventAtMs: at + Math.round(wall * fraction) }));
    }
    const root = { version, trace, stage: "worker" as const, kind: "scheduled" as const, label: "scheduled */5 * * * *", status: null, cpuMs: Math.round(lognormal(next, 14, 0.2)), wallMs: wall, eventAtMs: at };
    if (pollFails) pending.push(await failing({ ...root, outcome: "ok", errors: [{ source: "caught", operation: "deployments.poll", name: "Error", message: "upstream", stack: stack(version, POLL) }] }));
    else pending.push(plain({ ...root, outcome: "ok" }));
  };

  const resolveAt = now - 1.5 * D;
  let resolved = false;
  const parseFault = (version: string, at: number) => ((version === V13.id && at < now - 1.6 * D) || version === V14.id) && next() < 0.06 ? "uncaught" as const : null;
  const flush = (until: number) => { ingest(db, pending.splice(0), until); };

  for (let minute = start; minute < now; minute += M) {
    for (let upload = 0; upload < 4; upload++) {
      await request("POST /ingest/v1/batches", "Installation POST /ingest", minute + upload * 15 * S + Math.floor(next() * 4000), { median: 16, sigma: 0.3 },
        version => version === V14.id && next() < 0.015 ? "caught" : null);
    }
    if (next() < 12 / 60) await request("GET /api/v1/hosts/:host/history", "Installation GET /hosts/:host/history", minute + Math.floor(next() * M), { median: 26, sigma: 0.55 }, null);
    if (next() < 6 / 60) await request("GET /api/v1/projects/:project/history", "Installation GET /projects/:project/history", minute + Math.floor(next() * M), { median: 12, sigma: 0.45 }, null);
    if (next() < 4 / 60) { const at = minute + Math.floor(next() * M); await request("GET /api/v1/projects", "Installation GET /projects", at, { median: 4, sigma: 0.3 }, version => parseFault(version, at)); }
    if (next() < 4 / 60) await request("GET /api/v1/hosts", "Installation GET /hosts", minute + Math.floor(next() * M), { median: 4, sigma: 0.3 }, null);
    if (next() < 3 / 60) await request("GET /api/v1/projects/:project/deployments", "Installation GET /projects/:project/deployments", minute + Math.floor(next() * M), { median: 6, sigma: 0.3 }, null);
    if ((minute / M) % 5 === 0) await scheduled(minute + 120);
    if ((minute / M) % 60 === 0) flush(minute + M);
    if (!resolved && minute >= resolveAt) {
      flush(minute);
      const parse = listIssues(db, minute, { limit: 100 }).items.find(issue => issue.name === "TypeError" && issue.operation === null && issue.frame?.startsWith("parseProjects") === true);
      if (parse !== undefined) setIssueState(db, minute, parse.fingerprint, "resolved");
      resolved = true;
    }
  }
  flush(now);
  const service = createObserveService(db, { now: () => now, databaseBytes: () => 0 });
  for (const version of [V13, V14]) {
    const outcome = await service.artifact({ version: version.id, file: "index.js", map: bundleMap(version.id) });
    if (!("result" in outcome)) throw new Error(`scenario map rejected: ${outcome.problem}`);
  }
  const invocations = db.rows<{ n: number }>("SELECT COUNT(*) AS n FROM observe_invocations")[0]?.n ?? 0;
  const deployments: DeploymentHistory = {
    projectId: "stats", worker: "stats", enabled: true,
    sync: { lastAttemptAtMs: now - 2 * M, lastSuccessAtMs: now - 2 * M, error: null, truncated: false },
    deployments: [...plan].reverse().map(rollout => ({ id: rollout.id, atMs: rollout.at, source: "wrangler", message: rollout.message, deferred: false, versions: rollout.shares.map(share => ({ id: share.version, percentage: share.percent })) })),
    versions: SCENARIO_VERSIONS.map(version => ({ id: version.id, tag: version.tag, message: version.message }))
  };
  return { db, deployments, invocations };
}

export function scenarioStore(scenario: Scenario, now: number): ObserveService {
  return createObserveService(scenario.db, { now: () => now, databaseBytes: () => 0 });
}

export async function answer(scenario: Scenario, now: number, request: Request): Promise<Response> {
  return handleApi(request, new URL(request.url).pathname, scenarioStore(scenario, now));
}

export function scenarioComparison(scenario: Scenario, deploymentId: string, window: "1h" | "6h" | "24h"): object | null {
  const deployment = scenario.deployments.deployments.find(item => item.id === deploymentId);
  if (deployment === undefined) return null;
  const span = { "1h": H, "6h": 6 * H, "24h": D }[window];
  const end = Math.floor(deployment.atMs / (5 * M)) * 5 * M;
  return {
    deploymentId, window, before: { fromMs: end - span, toMs: end }, after: { fromMs: end + 10 * M, toMs: end + 10 * M + span },
    readyAtMs: end + 10 * M + span, beforeInvocations: null, afterInvocations: null,
    reasons: ["The scenario has no collected Worker metrics to compare."], warnings: [], metrics: []
  };
}
