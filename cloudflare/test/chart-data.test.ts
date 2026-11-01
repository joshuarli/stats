import { describe, expect, it } from "vitest";
import { alignSeries, duration, panWindow, pointsIn, windowIndexes, windowStats } from "../src/client/chart-data";

describe("chart data", () => {
  it("keeps a missing value as a gap instead of interpolating or zeroing it", () => {
    const aligned = alignSeries([
      [{ atMs: 1_000, value: 1 }, { atMs: 2_000, value: undefined }, { atMs: 3_000, value: 3 }],
      [{ atMs: 1_000, value: 10 }, { atMs: 3_000, value: 30 }]
    ]);
    expect(aligned.times).toEqual([1_000, 2_000, 3_000]);
    expect(aligned.columns).toEqual([[1, null, 3], [10, null, 30]]);
  });

  it("joins series whose sample times jitter onto one step grid", () => {
    const aligned = alignSeries([
      [{ atMs: 15_010, value: 1 }, { atMs: 30_020, value: 2 }],
      [{ atMs: 14_990, value: 5 }, { atMs: 44_990, value: 7 }]
    ], 15_000);
    expect(aligned.times).toEqual([15_000, 30_000, 45_000]);
    expect(aligned.columns).toEqual([[1, 2, null], [5, null, 7]]);
  });

  it("fills a gap at the start of a window with null slots", () => {
    const aligned = alignSeries([
      [{ atMs: 0, value: 1 }, { atMs: 60_000, value: 2 }, { atMs: 75_000, value: 3 }, { atMs: 90_000, value: 4 }]
    ], 15_000);
    expect(aligned.times).toEqual([0, 15_000, 30_000, 45_000, 60_000, 75_000, 90_000]);
    expect(aligned.columns).toEqual([[1, null, null, null, 2, 3, 4]]);
  });

  it("fills an outage in the middle of a window instead of bridging it", () => {
    const resume = 15_000 + 196 * 15_000;
    const aligned = alignSeries([
      [{ atMs: 0, value: 1 }, { atMs: 15_000, value: 2 }, { atMs: resume, value: 3 }, { atMs: resume + 15_000, value: 4 }]
    ], 15_000);
    expect(aligned.times).toHaveLength(199);
    expect(aligned.times[0]).toBe(0);
    expect(aligned.times.at(-1)).toBe(resume + 15_000);
    expect(aligned.columns[0]!.slice(0, 2)).toEqual([1, 2]);
    expect(aligned.columns[0]!.slice(2, -2).every(value => value === null)).toBe(true);
    expect(aligned.columns[0]!.slice(-2)).toEqual([3, 4]);
  });

  it("computes window statistics over present values only", () => {
    const values = [4, null, 8, 2, null];
    expect(windowStats(values, 0, 4)).toEqual({ min: 2, avg: 14 / 3, max: 8, last: 2 });
    expect(windowStats(values, 1, 1)).toBeUndefined();
    expect(windowStats(values, 2, 3)).toEqual({ min: 2, avg: 5, max: 8, last: 2 });
  });

  it("selects the sample indexes inside a time window", () => {
    const times = [1_000, 2_000, 3_000, 4_000];
    expect(windowIndexes(times, null)).toEqual([0, 3]);
    expect(windowIndexes(times, { fromMs: 1_500, toMs: 3_500 })).toEqual([1, 2]);
    expect(windowIndexes(times, { fromMs: 9_000, toMs: 10_000 })).toEqual([4, 3]);
    expect(pointsIn([{ atMs: 1_000 }, { atMs: 2_000 }, { atMs: 3_000 }], { fromMs: 1_500, toMs: 3_000 })).toEqual([{ atMs: 2_000 }, { atMs: 3_000 }]);
  });

  it("pans by half a window and never leaves the loaded bounds", () => {
    const bounds = { fromMs: 0, toMs: 100_000 };
    expect(panWindow({ fromMs: 40_000, toMs: 60_000 }, 1, bounds)).toEqual({ fromMs: 50_000, toMs: 70_000 });
    expect(panWindow({ fromMs: 85_000, toMs: 100_000 }, 1, bounds)).toEqual({ fromMs: 85_000, toMs: 100_000 });
    expect(panWindow({ fromMs: 5_000, toMs: 25_000 }, -1, bounds)).toEqual({ fromMs: 0, toMs: 20_000 });
  });

  it("formats window durations at the unit a reader scans", () => {
    expect(duration(45_000)).toBe("45s");
    expect(duration(18 * 60_000)).toBe("18m");
    expect(duration(5 * 3_600_000)).toBe("5h");
    expect(duration(3 * 86_400_000)).toBe("3d");
  });
});
