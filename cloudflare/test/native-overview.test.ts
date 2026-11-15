import { describe, expect, it } from "vitest";
import { applicationOverview, operationLabel } from "../src/client/pages/project/native-overview.ts";
import type { ApplicationSummary, ApplicationTotals } from "../src/observe/application/telemetry.ts";

const first: ApplicationTotals = { events: 2, failed: 0, cancelled: 0, requests: 1, requestDurationMsSum: 14, requestDurationMsMax: 14, status2xx: 1, status3xx: 0, status4xx: 0, status5xx: 0, durationMsSum: 134, durationMsMax: 120, firstAtMs: 1000, lastAtMs: 1001 };
const last: ApplicationTotals = { ...first, events: 4, failed: 2, cancelled: 1, requests: 2, requestDurationMsSum: 100, requestDurationMsMax: 80, status5xx: 1, durationMsSum: 160, firstAtMs: 3000, lastAtMs: 3001 };
const data: ApplicationSummary = { provenance: "application", fromMs: 1000, toMs: 3500, stepMs: 1000, openIssues: 0, totals: { ...first, events: 6, failed: 2, cancelled: 1, requests: 3, requestDurationMsSum: 114, requestDurationMsMax: 80, status2xx: 2, status5xx: 1, durationMsSum: 294, lastAtMs: 3001 }, buckets: [{ ...first, atMs: 1000 }, { ...last, atMs: 3000 }], operations: [], moreOperations: false };

describe("native project overview", () => {
  it("locates the first failure bucket and labels a measured mean change with sample counts", () => {
    const model = applicationOverview(data);
    expect(model.firstFailure?.atMs).toBe(3000);
    expect(model.latencyChange).toEqual({ baselineAtMs: 1000, atMs: 3000, baselineMeanMs: 14, meanMs: 50, baselineCount: 1, count: 2 });
  });
  it("does not infer a latency change from absent samples or a zero-duration reference", () => {
    expect(applicationOverview({ ...data, totals: null, buckets: [] }).latencyChange).toBeNull();
    expect(applicationOverview({ ...data, buckets: [{ ...first, requestDurationMsSum: 0, atMs: 1000 }, { ...last, atMs: 3000 }] }).latencyChange).toBeNull();
  });
  it("separates HTTP wall time from background work and excludes cancellations from failures", () => {
    const model = applicationOverview(data);
    expect(model.http).toBe(true);
    expect(model.count).toBe(3);
    expect(model.meanMs).toBe(38);
    expect(model.maxMs).toBe(80);
    expect(model.failed).toBe(1);
    expect(model.failures).toBe(1);
    expect(model.errorPercent).toBeCloseTo(100 / 3);
    expect(model.needsAttention).toBe(true);
  });
  it("keeps gaps and scales a partial final bucket by its actual covered time", () => {
    const model = applicationOverview(data);
    expect(model.traffic.values).toEqual([60, null, 240]);
    expect(model.mean.values).toEqual([14, null, 50]);
    expect(model.failureTrack.values).toEqual([0, null, 1]);
  });
  it("uses reported application work when HTTP request instrumentation is absent", () => {
    const work = { ...first, requests: 0, requestDurationMsSum: 0, requestDurationMsMax: 0, status2xx: 0 };
    const model = applicationOverview({ ...data, totals: work, buckets: [{ ...work, atMs: 1000 }] });
    expect(model.http).toBe(false);
    expect(model.count).toBe(2);
    expect(model.meanMs).toBe(67);
    expect(model.errorPercent).toBeNull();
  });
  it("reports missing activity without making up zero latency or healthy traffic", () => {
    const model = applicationOverview({ ...data, totals: null, buckets: [] });
    expect(model.events).toBe(0);
    expect(model.meanMs).toBeNull();
    expect(model.maxMs).toBeNull();
    expect(model.traffic.values).toEqual([null, null, null]);
    expect(model.operations).toEqual([]);
    expect(applicationOverview({ ...data, totals: null, buckets: [], openIssues: 1 }).needsAttention).toBe(true);
  });
  it("ranks and bounds actual operation wall time without counting logical work as HTTP", () => {
    const operations = Array.from({ length: 8 }, (_, index) => ({ ...first, operation: `http.get.route-${index}`, requestDurationMsSum: index * 10 }));
    operations.push({ ...first, operation: "cleanup.retention", requests: 0, durationMsSum: 1_000_000 });
    const model = applicationOverview({ ...data, operations });
    expect(model.operations).toHaveLength(5);
    expect(model.operations[0]?.operation).toBe("http.get.route-7");
    expect(model.operations[0]?.widthPercent).toBe(100);
    expect(model.omittedOperations).toBe(3);
    expect(model.operations.some(operation => operation.operation === "cleanup.retention")).toBe(false);
  });
  it("rejects inconsistent cancellation counters", () => {
    expect(() => applicationOverview({ ...data, totals: { ...first, cancelled: 1 } })).toThrow("cancellations exceed unsuccessful events");
  });
  it("flags reported HTTP server errors even when the producer labels the outcome successful", () => {
    expect(applicationOverview({ ...data, totals: { ...first, status5xx: 1 } }).needsAttention).toBe(true);
  });
  it("keeps bounded route labels readable while retaining raw operation identity", () => {
    expect(operationLabel("http.get.service-comparison")).toBe("GET service comparison");
    expect(operationLabel("host.ingest")).toBe("host ingest");
  });
});
