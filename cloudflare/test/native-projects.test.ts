import { describe, expect, it } from "vitest";
import { decodeApplicationTelemetry } from "../src/client/api.ts";
import { applicationTrack, nativeProjects } from "../src/client/pages/project/native-series.ts";
import type { ApplicationTelemetry, ApplicationTotals } from "../src/observe/application/telemetry.ts";
import { decodeCapabilities, type RuntimeCapabilities } from "../src/core/capabilities.ts";

const total: ApplicationTotals = { events: 2, failed: 0, cancelled: 0, requests: 1, requestDurationMsSum: 14, requestDurationMsMax: 14, status2xx: 1, status3xx: 0, status4xx: 0, status5xx: 0, durationMsSum: 34, durationMsMax: 20, firstAtMs: 1000, lastAtMs: 1001 };
const data: ApplicationTelemetry = { provenance: "application", fromMs: 1000, toMs: 4000, stepMs: 1000, totals: total, openIssues: 0, buckets: [{ ...total, atMs: 1000 }, { ...total, events: 4, atMs: 3000 }], operations: [], moreOperations: false, recent: [], moreRecent: false };

describe("native project telemetry", () => {
  it("selects the declared project source independently of provider availability", () => {
    const capabilities: RuntimeCapabilities = { projectSource: "services", applicationEvents: true, analyticsCollection: false, cloudflareDeployments: false, tailEvents: false, infraMetrics: false };
    expect(nativeProjects(capabilities)).toBe(true);
    expect(nativeProjects({ ...capabilities, projectSource: "cloudflare" })).toBe(false);
    expect(decodeCapabilities(capabilities)).toEqual(capabilities);
    expect(() => decodeCapabilities({ ...capabilities, projectSource: undefined })).toThrow("invalid project source");
    expect(() => decodeCapabilities({ ...capabilities, projectSource: "unknown" })).toThrow("invalid project source");
  });
  it("decodes exact window counts and renders missing time buckets as gaps", () => {
    const decoded = decodeApplicationTelemetry(data);
    expect(applicationTrack(decoded, bucket => bucket.events)).toEqual({ times: [1000, 2000, 3000], values: [2, null, 4] });
    expect(applicationTrack({ ...decoded, buckets: [] }, bucket => bucket.events).values).toEqual([null, null, null]);
    expect(decodeApplicationTelemetry({ ...data, totals: null, buckets: [] }).totals).toBeNull();
  });
  it("rejects unsafe aggregates, buckets outside the window and excessive detail", () => {
    expect(() => decodeApplicationTelemetry({ ...data, totals: { ...total, events: Number.MAX_SAFE_INTEGER + 1 } })).toThrow("expected a nonnegative safe integer");
    expect(() => decodeApplicationTelemetry({ ...data, buckets: [{ ...total, atMs: 4000 }] })).toThrow("invalid application telemetry window");
    expect(() => decodeApplicationTelemetry({ ...data, buckets: Array.from({ length: 121 }, () => ({ ...total, atMs: 1000 })) })).toThrow("application telemetry exceeds response limits");
    expect(() => decodeApplicationTelemetry({ ...data, stepMs: 0 })).toThrow("invalid application telemetry window");
  });
});
