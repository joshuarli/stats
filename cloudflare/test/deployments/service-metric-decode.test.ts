import assert from "node:assert/strict";
import test from "node:test";
import { compareServiceDeployment } from "../../src/deployments/service-compare.ts";
import { decodeServiceComparison } from "../../src/deployments/service-decode.ts";
import { decodeDeploymentComparison } from "../../src/deployments/decode.ts";
import { comparisonBounds } from "../../src/deployments/compare.ts";
import type { Deployment } from "../../src/deployments/model.ts";
import type { ExternalEventRecord } from "../../src/observe/ingest/model.ts";

await test("native comparisons decode all bounded application metrics beyond the Cloudflare limit", () => {
  const atMs = Date.UTC(2026, 10, 14, 12);
  const deployment: Deployment = { id: "00000000-0000-4000-8000-000000000002", atMs, source: "marker", message: null, versions: [{ id: "v2", percentage: 100 }], deferred: false };
  const previous: Deployment = { ...deployment, id: "00000000-0000-4000-8000-000000000001", atMs: atMs - 3_600_000 * 3, versions: [{ id: "v1", percentage: 100 }] };
  const bounds = comparisonBounds(atMs, "1h");
  const events: ExternalEventRecord[] = [];
  for (const side of ["before", "after"] as const) for (let index = 0; index < 4; index++) {
    const eventId = `${side}-${index}`;
    events.push({ eventId, service: "stats", receivedAtMs: atMs, provenance: "application", event: { schemaVersion: 1, eventId, service: "stats", atMs: bounds[side].fromMs + 1000, operation: `operation-${index}`, outcome: "ok", durationMs: 10, work: Object.fromEntries(Array.from({ length: 8 }, (_, key) => [`key${key}`.padEnd(32, "x"), 1])), release: side === "before" ? "v1" : "v2" } });
  }
  const comparison = compareServiceDeployment({ service: "stats", deployment, deployments: [deployment, previous], hostIds: [], hostRollups: () => [], probeRows: [], probeSource: "no-health-url", window: "1h", now: atMs + 3_600_000 * 3, truncated: false, applicationEvents: events });
  assert.ok(comparison.metrics.length > 96);
  const wire: unknown = JSON.parse(JSON.stringify(comparison));
  assert.deepEqual(decodeServiceComparison(wire, deployment.id, "1h"), comparison);
  assert.throws(() => decodeDeploymentComparison(wire, deployment.id, "1h"), /invalid deployment array/);
  assert.throws(() => decodeServiceComparison({ ...comparison, metrics: Array.from({ length: 10_000 }, () => comparison.metrics[0]) }, deployment.id, "1h"), /invalid deployment array/);
});
