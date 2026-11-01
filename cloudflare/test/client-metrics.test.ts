import { describe, expect, it } from "vitest";
import type { SummaryPoint } from "../src/client/api";
import { cpuUsed, latestPoint, memoryUsed, psiCpu, sparkPoints, sumLatest } from "../src/client/metrics";

function point(overrides: Partial<SummaryPoint> = {}): SummaryPoint {
  return { atMs: 1_000, coverageMs: 15_000, partial: false, ...overrides };
}

describe("client metrics", () => {
  it("keeps absent metrics absent instead of turning them into zero", () => {
    expect(cpuUsed(point())).toBeUndefined();
    expect(memoryUsed(point())).toBeUndefined();
    expect(psiCpu(point())).toBeUndefined();
    expect(sparkPoints([point()], cpuUsed)).toEqual([{ atMs: 1_000, value: undefined }]);
  });

  it("derives CPU, memory, and pressure values only from present fields", () => {
    const sample = point({
      cpu: { user: 8, system: 3, idle: 80, iowait: 1, steal: 0 },
      mem: { total: 8_000, available: 3_000, swapUsed: 0 },
      psi: { cpu: { some10: 1.2, some60: 0.8, some300: 0.4 } }
    });
    expect(cpuUsed(sample)).toBe(11);
    expect(memoryUsed(sample)).toBe(62.5);
    expect(psiCpu(sample)).toBe(1.2);
  });

  it("treats an empty disk as unavailable rather than zero", () => {
    expect(sumLatest<{ readonly value: number }>([{ points: [] }], value => value.value)).toBeUndefined();
    expect(sumLatest<{ readonly value: number }>([{ points: [{ value: 4 }, { value: 6 }] }, { points: [] }], value => value.value)).toBe(6);
  });

  it("selects the final ordered sample", () => {
    expect(latestPoint([])).toBeUndefined();
    expect(latestPoint([point({ atMs: 2_000 }), point({ atMs: 3_000 })])?.atMs).toBe(3_000);
  });
});
