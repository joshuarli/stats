import { describe, expect, it } from "vitest";
import { decodeApplicationTelemetry } from "../src/client/api.ts";
import { applicationTrack, nativeProjects } from "../src/client/pages/project/native-series.ts";
import type { ApplicationTelemetry, ApplicationTotals } from "../src/observe/application/telemetry.ts";

const total: ApplicationTotals = { events: 2, failed: 0, requests: 1, status2xx: 1, status3xx: 0, status4xx: 0, status5xx: 0, durationMsSum: 34, durationMsMax: 20, firstAtMs: 1000, lastAtMs: 1001 };
const data: ApplicationTelemetry = { provenance: "application", fromMs: 1000, toMs: 4000, stepMs: 1000, totals: total, buckets: [{ ...total, atMs: 1000 }, { ...total, events: 4, atMs: 3000 }], operations: [], moreOperations: false, recent: [], moreRecent: false };

describe("native project telemetry", () => {
  it("selects application views only when provider collection is disabled", () => {
    const capabilities = { applicationEvents: true, analyticsCollection: false, cloudflareDeployments: false, tailEvents: false };
    expect(nativeProjects(capabilities)).toBe(true);
    for (const key of ["analyticsCollection", "cloudflareDeployments", "tailEvents"] as const) expect(nativeProjects({ ...capabilities, [key]: true })).toBe(false);
    expect(nativeProjects({ ...capabilities, applicationEvents: false })).toBe(false);
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
