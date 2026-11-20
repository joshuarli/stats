import { describe, expect, it } from "vitest";
import { barState, combinedPoints, NEVER_IDLE_CORES, neverIdle, selectedWindow, uptime } from "../src/client/service-metrics";
import type { ResourcePoint } from "../src/core/installation/service-resources-model";

const point = (atMs: number, cpuCores: number | null, memoryBytes: number | null = null): ResourcePoint => ({ atMs, cpuCores, memoryBytes, ioBytesPerSec: null });

describe("service metrics", () => {
  it("flags a service as never idle only when every reported CPU level stays at the threshold for enough of the window", () => {
    const steady = Array.from({ length: 12 }, (_, index) => point(index, NEVER_IDLE_CORES + 0.5));
    expect(neverIdle(steady)).toBe(true);
    expect(neverIdle([...steady.slice(0, 11), point(11, 0.01)])).toBe(false);
    expect(neverIdle(steady.slice(0, 5))).toBe(false);
    expect(neverIdle([...steady, point(12, null)])).toBe(true);
  });

  it("sums a service's hosts point by point and keeps gaps where no host reported", () => {
    const combined = combinedPoints([{ points: [point(0, 0.5, 100), point(1, null, null)] }, { points: [point(0, 0.25, 50), point(1, null, null)] }]);
    expect(combined).toEqual([point(0, 0.75, 150), point(1, null, null)]);
  });

  it("classifies health bars and computes uptime over probes, not bars", () => {
    expect([{ probes: 0, up: 0 }, { probes: 4, up: 4 }, { probes: 4, up: 1 }, { probes: 2, up: 0 }].map(bar => barState({ atMs: 0, meanMs: null, ...bar }))).toEqual(["none", "up", "degraded", "down"]);
    expect(uptime([{ atMs: 0, probes: 3, up: 3, meanMs: 10 }, { atMs: 1, probes: 1, up: 0, meanMs: null }])).toBe(75);
    expect(uptime([{ atMs: 0, probes: 0, up: 0, meanMs: null }])).toBeNull();
  });

  it("follows a zoomed view and otherwise ends the range at now", () => {
    expect(selectedWindow("1h", null, 10_000_000)).toEqual({ fromMs: 10_000_000 - 3_600_000, toMs: 10_000_000 });
    expect(selectedWindow("1h", { fromMs: 5, toMs: 9 }, 10_000_000)).toEqual({ fromMs: 5, toMs: 9 });
  });
});
