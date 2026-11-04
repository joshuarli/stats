import type { Page, Route } from "@playwright/test";

const S = 1000;
const M = 60 * S;
const VERSION = "2221f9c2-9bd2-4011-bebb-52133d498752";
const PREVIOUS = "dc8c3793-ef1e-4f93-9d67-6c2ca62021e2";
const OBJECT = "a3f9c1e2b4d6f8a0c2e4f6a8b0d2f4e6a8c0e2f4a6b8d0f2e4a6c8e0f2a4b6c8";

export const TRACE_INGEST = "4f2a99c0d1e2f3a4b5c6d7e8f9a0b1c2";
export const TRACE_SCHEDULED = "9b1c7d3e5f6a7b8c9d0e1f2a3b4c5d6e";
export const ISSUE_POLL = "a".repeat(64);
export const ISSUE_REQUEST = "b".repeat(64);
export const ISSUE_RESOLVED = "c".repeat(64);

interface Invocation {
  key: string; traceId: string | null; stage: "worker" | "object"; kind: "fetch" | "rpc" | "alarm" | "scheduled"; label: string; objectId: string | null;
  status: number | null; outcome: string; failed: boolean; cpuMs: number; wallMs: number; atMs: number; version: string | null; errorCount: number;
}

function invocation(fields: Partial<Invocation> & Pick<Invocation, "key" | "label" | "atMs" | "wallMs" | "cpuMs">): Invocation {
  return { traceId: null, stage: "worker", kind: "fetch", objectId: null, status: 200, outcome: "ok", failed: false, version: VERSION, errorCount: 0, ...fields };
}

const POLL_FRAMES = [
  { fn: "request", file: "src/deployments/collector.ts", line: 58, column: 11 },
  { fn: "collectProject", file: "src/deployments/collector.ts", line: 81, column: 24 },
  { fn: "collectDeployments", file: "src/deployments/collector.ts", line: 131, column: 5 },
  { fn: "scheduled", file: "src/index.ts", line: 117, column: 11 },
  { fn: null, file: "node:internal/process/task_queues", line: 95, column: 5 }
];
const REQUEST_FRAMES = [
  { fn: "rebuildHour", file: "src/installation.ts", line: 419, column: 9 },
  { fn: "rebuildRollups", file: "src/installation.ts", line: 427, column: 12 },
  { fn: "ingest", file: "src/installation.ts", line: 642, column: 7 },
  { fn: "Installation.fetch", file: "src/installation.ts", line: 680, column: 39 }
];

export function observeFixture(now: number) {
  const ingestRoot = invocation({ key: "1a00000000000001", traceId: TRACE_INGEST, label: "POST /ingest/v1/batches", atMs: now - 38 * S, wallMs: 64, cpuMs: 1 });
  const ingestObject = invocation({ key: "1a00000000000002", traceId: TRACE_INGEST, stage: "object", label: "Installation POST /ingest", objectId: OBJECT, atMs: now - 38 * S + 9, wallMs: 49, cpuMs: 18 });
  const scheduledRoot = invocation({ key: "2b00000000000001", traceId: TRACE_SCHEDULED, kind: "scheduled", label: "scheduled */5 * * * *", status: null, failed: true, errorCount: 1, atMs: now - 4 * M, wallMs: 1842, cpuMs: 14 });
  const scheduledObjects = [
    invocation({ key: "2b00000000000002", traceId: TRACE_SCHEDULED, stage: "object", kind: "rpc", label: "Installation.knownDeploymentVersions", objectId: OBJECT, status: null, atMs: now - 4 * M + 412, wallMs: 7, cpuMs: 1 }),
    invocation({ key: "2b00000000000003", traceId: TRACE_SCHEDULED, stage: "object", kind: "rpc", label: "Installation.recordDeploymentPoll", objectId: OBJECT, status: null, atMs: now - 4 * M + 1496, wallMs: 11, cpuMs: 2 }),
    invocation({ key: "2b00000000000004", traceId: TRACE_SCHEDULED, stage: "object", kind: "rpc", label: "Installation.recordCollectorRun", objectId: OBJECT, status: null, atMs: now - 4 * M + 1781, wallMs: 46, cpuMs: 27 })
  ];
  const pollOccurrence = { id: 9001, invocationKey: scheduledRoot.key, traceId: TRACE_SCHEDULED, atMs: scheduledRoot.atMs + 1490, version: VERSION, source: "caught", operation: "deployments.poll", name: "Error", message: null, frames: POLL_FRAMES };
  const requestOccurrence = { id: 9002, invocationKey: "3c00000000000002", traceId: "7e1d2c3b4a5968778695a4b3c2d1e0f9", atMs: now - 47 * M, version: PREVIOUS, source: "caught", operation: "installation.request", name: "RangeError", message: null, frames: REQUEST_FRAMES };

  const roots: Invocation[] = [ingestRoot, scheduledRoot];
  const routes = ["POST /ingest/v1/batches", "GET /api/v1/hosts", "GET /api/v1/hosts/:host/history", "GET /api/v1/projects/:project/history", "GET /api/v1/projects/:project/deployments"];
  for (let index = 0; index < 22; index++) {
    const label = routes[index % routes.length]!;
    const failed = index === 7;
    roots.push(invocation({
      key: `4d${String(index).padStart(14, "0")}`, traceId: `${(index + 0x10).toString(16).padStart(2, "0")}${"5e6f".repeat(7)}a0b1`.slice(0, 32), label,
      status: failed ? 500 : label.startsWith("POST") ? 200 : 200, failed, errorCount: failed ? 1 : 0,
      atMs: now - (index + 1) * 2.5 * M - (index % 3) * 7 * S, wallMs: label.includes("history") ? 90 + (index * 37) % 140 : 40 + (index * 13) % 50, cpuMs: label.includes("history") ? 2 : 1
    }));
  }
  roots.sort((a, b) => b.atMs - a.atMs);
  const traces = roots.map(root => {
    const objects = root.traceId === TRACE_INGEST ? [ingestObject] : root.traceId === TRACE_SCHEDULED ? scheduledObjects : [];
    const objectCpu = objects.length > 0 ? objects.reduce((sum, item) => sum + item.cpuMs, 0) : root.label.includes("history") ? 31 : 12;
    return { ...root, objectInvocations: objects.length > 0 ? objects.length : 1, objectCpuMs: objectCpu };
  });

  const details: Record<string, unknown> = {
    [TRACE_INGEST]: { traceId: TRACE_INGEST, rootPresent: true, truncated: false, invocations: [ingestRoot, ingestObject], occurrences: [] },
    [TRACE_SCHEDULED]: { traceId: TRACE_SCHEDULED, rootPresent: true, truncated: false, invocations: [scheduledRoot, ...scheduledObjects], occurrences: [pollOccurrence] }
  };
  for (const root of roots) {
    if (root.traceId === null || details[root.traceId] !== undefined) continue;
    const object = invocation({ key: `${root.key.slice(0, 15)}f`, traceId: root.traceId, stage: "object", label: `Installation ${root.label.replace(/^(\w+) \/api\/v1/u, "$1")}`, objectId: OBJECT, atMs: root.atMs + 6, wallMs: Math.max(1, root.wallMs - 14), cpuMs: root.label.includes("history") ? 31 : 12, status: root.status });
    details[root.traceId] = { traceId: root.traceId, rootPresent: true, truncated: false, invocations: [root, object], occurrences: [] };
  }

  const issues = [
    { fingerprint: ISSUE_POLL, name: "Error", operation: "deployments.poll", frame: "request (src/deployments/collector.ts:58)", state: "open", occurrences: 2016, firstAtMs: now - 7 * 24 * 60 * M + 3 * M, lastAtMs: scheduledRoot.atMs + 1490, lastVersion: VERSION, versions: 2 },
    { fingerprint: ISSUE_REQUEST, name: "RangeError", operation: "installation.request", frame: "rebuildHour (src/installation.ts:419)", state: "open", occurrences: 3, firstAtMs: now - 26 * 60 * M, lastAtMs: requestOccurrence.atMs, lastVersion: PREVIOUS, versions: 1 },
    { fingerprint: ISSUE_RESOLVED, name: "TypeError", operation: null, frame: "parseProjects (src/projects/config.ts:41)", state: "resolved", occurrences: 1, firstAtMs: now - 3 * 24 * 60 * M, lastAtMs: now - 3 * 24 * 60 * M, lastVersion: PREVIOUS, versions: 1 }
  ];
  const occurrences: Record<string, unknown[]> = {
    [ISSUE_POLL]: Array.from({ length: 12 }, (_, index) => ({ ...pollOccurrence, id: 9001 - index, atMs: pollOccurrence.atMs - index * 5 * M, traceId: index === 0 ? TRACE_SCHEDULED : `${"9b1c".repeat(7)}${String(index).padStart(4, "0")}`, version: index < 9 ? VERSION : PREVIOUS })),
    [ISSUE_REQUEST]: [requestOccurrence, { ...requestOccurrence, id: 8990, atMs: now - 9 * 60 * M }, { ...requestOccurrence, id: 8980, atMs: now - 26 * 60 * M }],
    [ISSUE_RESOLVED]: [{ ...requestOccurrence, id: 7001, name: "TypeError", operation: null, source: "uncaught", atMs: now - 3 * 24 * 60 * M, frames: [{ fn: "parseProjects", file: "src/projects/config.ts", line: 41, column: 13 }] }]
  };
  const health = { newestAtMs: now - 38 * S, oldestAtMs: now - 7 * 24 * 60 * M + 2 * M, liveInvocations: 71_284, cleanupBacklog: 0, cleanupLagMs: 0, openIssues: 2, duplicate: 0, conflict: 0, expired: 0, future: 0, rejected: 0, issueCapacity: 0, evicted: 0, databaseBytes: 25_034_752 };
  return { traces, details, issues, occurrences, health };
}

export async function mockObserve(page: Page, now: number, options: { readonly failing?: boolean } = {}): Promise<{ readonly requests: string[]; readonly posts: { path: string; body: unknown }[] }> {
  const fixture = observeFixture(now);
  const requests: string[] = [];
  const posts: { path: string; body: unknown }[] = [];
  const states = new Map(fixture.issues.map(issue => [issue.fingerprint, issue.state]));
  await page.route("**/api/observe/**", async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.slice("/api/observe".length);
    requests.push(path + url.search);
    if (options.failing === true) return route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "observe down" } } });
    const state = /^\/issues\/([0-9a-f]{64})\/state$/u.exec(path);
    if (state !== null && route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { state: string };
      posts.push({ path, body });
      states.set(state[1]!, body.state);
      return route.fulfill({ status: 204 });
    }
    if (path === "/health") return route.fulfill({ json: fixture.health });
    if (path === "/traces") {
      const failed = url.searchParams.get("failed");
      const label = url.searchParams.get("label");
      return route.fulfill({ json: { items: fixture.traces.filter(trace => (failed === null || String(trace.failed) === failed) && (label === null || trace.label === label)), next: null } });
    }
    const trace = /^\/traces\/([0-9a-f]{32})$/u.exec(path);
    if (trace !== null) {
      const detail = fixture.details[trace[1]!];
      return detail === undefined ? route.fulfill({ status: 404, json: { error: { code: "not_found", message: "trace not found or expired" } } }) : route.fulfill({ json: detail });
    }
    if (path === "/issues") {
      const wanted = url.searchParams.get("state") ?? "open";
      return route.fulfill({ json: { items: fixture.issues.map(issue => ({ ...issue, state: states.get(issue.fingerprint) })).filter(issue => issue.state === wanted), next: null } });
    }
    const occurrences = /^\/issues\/([0-9a-f]{64})\/occurrences$/u.exec(path);
    if (occurrences !== null) return route.fulfill({ json: { items: fixture.occurrences[occurrences[1]!] ?? [], next: null } });
    return route.fulfill({ status: 404, json: { error: { code: "not_found", message: "unknown observe route" } } });
  });
  return { requests, posts };
}

export const STATS_PROJECT = {
  id: "stats", name: "stats", worker: "stats", buckets: [], durableObjectNamespaces: ["b25c2595ba784bb1bd51a87a3e87c62b"], d1Databases: [], probes: [],
  collector: { lastRunAtMs: 0, lastSuccessAtMs: 0, lastError: null, stale: false }
};
