import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { comparisonBounds, DEPLOYMENT_BUCKET_MS, type MetricRow } from "../../src/deployments/compare.ts";
import type { Deployment } from "../../src/deployments/model.ts";
import { compareServiceDeployment, SERVICE_LEVEL_CAVEAT } from "../../src/deployments/service-compare.ts";
import { parseServicePolicyText } from "../../src/cli/verify/policy.ts";
import { fakeOrigin, runCli, sendJson, tokenEnv } from "./support.ts";

const SCRATCH_ROOT = resolve(import.meta.dirname, "../../../.work/tmp");
mkdirSync(SCRATCH_ROOT, { recursive: true });
const scratch = mkdtempSync(join(SCRATCH_ROOT, "verify-service-"));

const HOUR = 3_600_000;
const HOST = `h_${"c".repeat(32)}`;
const AT = Date.UTC(2026, 10, 2, 12, 2, 0);
const marker = (n: number, atMs: number, version: string): Deployment => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, atMs, source: "marker", message: null, versions: [{ id: version, percentage: 100 }], deferred: false });
const PREVIOUS = marker(1, AT - 2 * HOUR, "1.0.0");
const CANDIDATE = marker(2, AT, "1.1.0");

function probeRows(window: { fromMs: number; toMs: number }, ms: number, up: number): MetricRow[] {
  const rows: MetricRow[] = [];
  for (let bucket = window.fromMs; bucket < window.toMs; bucket += DEPLOYMENT_BUCKET_MS) rows.push({ metric: "probe.health.ms", bucket_ms: bucket, value: ms }, { metric: "probe.health.up", bucket_ms: bucket, value: up });
  return rows;
}

function comparisonFor(deployment: Deployment, now: number, beforeMs: number, afterMs: number, hasHealthUrl = true) {
  const { before, after } = comparisonBounds(deployment.atMs, "1h");
  const rows = hasHealthUrl ? [...probeRows(before, beforeMs, 1), ...probeRows(after, afterMs, 1)] : [];
  return compareServiceDeployment({ deployment, deployments: [PREVIOUS, CANDIDATE], hostIds: [HOST], hostRollups: new Map(), probeRows: rows, hasHealthUrl, window: "1h", now, truncated: false });
}

function policyFile(name: string, over: Record<string, unknown> = {}): string {
  const path = join(scratch, name);
  writeFileSync(path, JSON.stringify({ schema: "statsctl-policy/1", id: "probe-latency", hypothesis: "The new build answers the health URL faster than the old one.", service: "web", metric: "probe.health.ms", direction: "decrease", minChangePercent: 10, floor: 10, window: "1h", ...over }));
  return path;
}

interface Document {
  readonly payload?: { readonly verdict: string; readonly caveat: string; readonly sources: { source: string; status: string }[]; readonly reasons: { code: string; message: string }[]; readonly target: { before: number | null; after: number | null } };
  readonly error?: { readonly code: string };
  readonly warnings?: { code: string }[];
}

async function verify(body: unknown, args: string[], policy = policyFile("policy.json"), deploymentId = CANDIDATE.id) {
  const origin = await fakeOrigin((_request, response) => sendJson(response, body));
  try {
    const run = await runCli(["verify", "--service", "web", "--deployment", deploymentId, "--policy", policy, "--origin", origin.origin, "--json", ...args], tokenEnv());
    return { run, document: JSON.parse(run.stdout) as Document, urls: origin.seen.map(seen => seen.url) };
  } finally {
    await origin.close();
  }
}

await test("a service policy is strict, limited to level metrics, and has no project or guardrails", () => {
  const text = (over: Record<string, unknown>) => JSON.stringify({ schema: "statsctl-policy/1", id: "p", hypothesis: "Lower CPU after the change.", service: "web", metric: "host.cpu", direction: "decrease", minChangePercent: 10, floor: 2, window: "1h", ...over });
  assert.equal(parseServicePolicyText(text({})).metric, "host.cpu");
  assert.throws(() => parseServicePolicyText(text({ metric: "worker.cpu" })), /metric must be one of/u);
  assert.throws(() => parseServicePolicyText(text({ floor: 1 })), /at least its default 2/u);
  assert.throws(() => parseServicePolicyText(text({ project: "stats" })), /unknown field project/u);
  assert.throws(() => parseServicePolicyText(text({ guardrails: [] })), /unknown field guardrails/u);
  assert.throws(() => parseServicePolicyText(text({ minChangePercent: 5 })), /at least 10/u);
});

await test("verify --service reads one comparison and judges resource levels with the Decision caveat on every verdict", async () => {
  const now = AT + 3 * HOUR;
  const improved = await verify(comparisonFor(CANDIDATE, now, 400, 40), []);
  assert.equal(improved.run.code, 0, improved.run.stdout + improved.run.stderr);
  assert.equal(improved.document.payload?.verdict, "improved");
  assert.equal(improved.document.payload?.caveat, SERVICE_LEVEL_CAVEAT);
  assert.deepEqual(improved.urls, [`/api/v1/services/web/deployments/${CANDIDATE.id}/comparison?window=1h`]);
  assert.ok(improved.document.warnings?.some(warning => warning.code === "resource-levels-only"));
  assert.deepEqual(improved.document.payload?.sources.map(source => source.status), ["unavailable", "available"]);

  const regressed = await verify(comparisonFor(CANDIDATE, now, 40, 400), []);
  assert.equal(regressed.run.code, 7);
  assert.equal(regressed.document.payload?.verdict, "regressed");

  const unchanged = await verify(comparisonFor(CANDIDATE, now, 100, 102), []);
  assert.equal(unchanged.run.code, 6);
  assert.equal(unchanged.document.payload?.verdict, "unchanged");

  const text = await runCliText(comparisonFor(CANDIDATE, now, 400, 40));
  assert.match(text, /service verdict improved/u);
  assert.match(text, /cannot show fewer resources for the same work/u);
});

async function runCliText(body: unknown): Promise<string> {
  const origin = await fakeOrigin((_request, response) => sendJson(response, body));
  try {
    const run = await runCli(["verify", "--service", "web", "--deployment", CANDIDATE.id, "--policy", policyFile("policy.json"), "--origin", origin.origin], tokenEnv());
    return run.stdout;
  } finally {
    await origin.close();
  }
}

await test("a source the service lacks is insufficient-data with the reason, never a pass", async () => {
  const now = AT + 3 * HOUR;
  const noProbe = await verify(comparisonFor(CANDIDATE, now, 0, 0, false), []);
  assert.equal(noProbe.run.code, 5);
  assert.equal(noProbe.document.payload?.verdict, "insufficient-data");
  assert.match(noProbe.document.payload?.reasons[0]?.message ?? "", /probe unavailable, The service has no health URL/u);
  assert.equal(noProbe.document.payload?.target.before, null);

  const hostMetric = await verify(comparisonFor(CANDIDATE, now, 40, 40), [], policyFile("host.json", { metric: "host.cpu", floor: 2 }));
  assert.equal(hostMetric.run.code, 5);
  assert.match(hostMetric.document.payload?.reasons[0]?.message ?? "", /hosts unavailable/u);
});

await test("a window that has not settled is pending and exits 5", async () => {
  const fresh = marker(3, Date.now() - 10 * 60_000, "1.2.0");
  const pending = await verify(comparisonFor(fresh, Date.now(), 100, 100), [], policyFile("policy.json"), fresh.id);
  assert.equal(pending.run.code, 5, pending.run.stdout);
  assert.equal(pending.document.payload?.verdict, "pending");
});

await test("--service refuses --project, --wait, and a policy for another service, and project verify refuses a Node origin", async () => {
  const policy = policyFile("policy.json");
  const base = ["verify", "--service", "web", "--deployment", CANDIDATE.id, "--policy", policy, "--json"];
  for (const extra of [["--project", "stats"], ["--wait"], ["--readiness"], ["--safety-check-file", "x"]]) {
    const run = await runCli([...base, ...extra], tokenEnv());
    assert.equal(run.code, 2, extra.join(" "));
  }
  const other = await runCli(["verify", "--service", "api", "--deployment", CANDIDATE.id, "--policy", policy, "--json"], tokenEnv());
  assert.equal(other.code, 2);
  assert.match(other.stderr, /policy is for service web, not api/u);
  const node = await runCli(["verify", "--project", "stats", "--deployment", CANDIDATE.id, "--policy", policy, "--origin", "http://threadripper:18790", "--json"], tokenEnv());
  assert.equal(node.code, 2);
  assert.equal((JSON.parse(node.stdout) as Document).error?.code, "unsupported_on_target");
});
