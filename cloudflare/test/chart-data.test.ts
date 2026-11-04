import { describe, expect, it } from "vitest";
import { alignTracks, duration, panWindow, sparkGeometry, sparkToneStops, sumTracks, windowIndexes, windowStats, windowTracks, worstTrack } from "../src/client/chart-data";

describe("chart data", () => {
  it("keeps a missing value as a gap instead of interpolating or zeroing it", () => {
    const aligned = alignTracks([
      { times: [1_000, 2_000, 3_000], values: [1, null, 3] },
      { times: [1_000, 3_000], values: [10, 30] }
    ]);
    expect(aligned.times).toEqual([1_000, 2_000, 3_000]);
    expect(aligned.columns).toEqual([[1, null, 3], [10, null, 30]]);
  });

  it("joins series whose sample times jitter onto one step grid", () => {
    const aligned = alignTracks([
      { times: [15_010, 30_020], values: [1, 2] },
      { times: [14_990, 44_990], values: [5, 7] }
    ], 15_000);
    expect(aligned.times).toEqual([15_000, 30_000, 45_000]);
    expect(aligned.columns).toEqual([[1, 2, null], [5, null, 7]]);
  });

  it("fills a gap at the start of a window with null slots", () => {
    const aligned = alignTracks([{ times: [0, 60_000, 75_000, 90_000], values: [1, 2, 3, 4] }], 15_000);
    expect(aligned.times).toEqual([0, 15_000, 30_000, 45_000, 60_000, 75_000, 90_000]);
    expect(aligned.columns).toEqual([[1, null, null, null, 2, 3, 4]]);
  });

  it("fills an outage in the middle of a window instead of bridging it", () => {
    const resume = 15_000 + 196 * 15_000;
    const aligned = alignTracks([{ times: [0, 15_000, resume, resume + 15_000], values: [1, 2, 3, 4] }], 15_000);
    expect(aligned.times).toHaveLength(199);
    expect(aligned.times[0]).toBe(0);
    expect(aligned.times.at(-1)).toBe(resume + 15_000);
    expect(aligned.columns[0]!.slice(0, 2)).toEqual([1, 2]);
    expect(aligned.columns[0]!.slice(2, -2).every(value => value === null)).toBe(true);
    expect(aligned.columns[0]!.slice(-2)).toEqual([3, 4]);
  });

  it("passes series that already share a gap-free axis through without copying", () => {
    const times = [15_000, 30_000, 45_000];
    const cpu = [1, null, 3];
    const load = [4, 5, 6];
    const aligned = alignTracks([{ times, values: cpu }, { times, values: load }], 15_000);
    expect(aligned.times).toBe(times);
    expect(aligned.columns[0]).toBe(cpu);
    expect(aligned.columns[1]).toBe(load);
  });

  it("snaps a shared axis with jitter and fills a shared axis with an outage", () => {
    const jittered = [15_010, 30_020, 44_990];
    const snapped = alignTracks([{ times: jittered, values: [1, 2, 3] }], 15_000);
    expect(snapped.times).toEqual([15_000, 30_000, 45_000]);
    expect(snapped.columns).toEqual([[1, 2, 3]]);
    const gapped = [0, 15_000, 60_000];
    const filled = alignTracks([{ times: gapped, values: [1, 2, 3] }, { times: gapped, values: [4, null, 6] }], 15_000);
    expect(filled.times).toEqual([0, 15_000, 30_000, 45_000, 60_000]);
    expect(filled.columns).toEqual([[1, 2, null, null, 3], [4, null, null, null, 6]]);
  });

  it("lets the later of two samples that snap to one slot win", () => {
    const aligned = alignTracks([{ times: [15_000, 15_001, 30_000], values: [1, 2, 3] }], 15_000);
    expect(aligned.times).toEqual([15_000, 30_000]);
    expect(aligned.columns).toEqual([[2, 3]]);
  });

  it("keeps a stale sparkline inside its sample window instead of stretching it to the edge", () => {
    const geometry = sparkGeometry([[1, 2]], [0, 15_000], { fromMs: 0, toMs: 60_000 }, false);
    expect(geometry?.paths).toEqual(["M0.00,36.00 L40.00,6.00"]);
    expect(geometry?.area).toBe("M0.00,40 L0.00,36.00 L40.00,6.00 L40.00,40 Z");
    expect(geometry?.dot).toEqual({ x: 40, y: 6 });
    expect(geometry?.gaps).toEqual([{ x0: 40, x1: 160 }]);
  });

  it("mirrors a second sparkline track below the shared baseline", () => {
    const geometry = sparkGeometry([[4, 4], [-2, -2]], undefined, undefined, true, true);
    expect(geometry?.paths).toEqual(["M0.00,6.00 L160.00,6.00", "M0.00,36.00 L160.00,36.00"]);
    expect(geometry?.areas).toEqual([
      "M0.00,26.00 L0.00,6.00 L160.00,6.00 L160.00,26.00 Z",
      "M0.00,26.00 L0.00,36.00 L160.00,36.00 L160.00,26.00 Z"
    ]);
    expect(geometry?.area).toBe(geometry?.areas[0]);
  });

  it("maps sparkline limits onto hot line stops", () => {
    const geometry = sparkGeometry([[0, 100]], undefined, undefined, true);
    const stops = sparkToneStops(geometry!, { elevated: 70, critical: 90, direction: "above" });
    expect(stops.map(stop => stop.tone)).toEqual(["critical", "critical", "elevated", "elevated", "base", "base"]);
    expect(stops[1]!.offset).toBeCloseTo(0.225);
    expect(stops[3]!.offset).toBeCloseTo(0.375);
  });

  it("breaks a sparkline path at a missing value", () => {
    const geometry = sparkGeometry([[1, null, 3]], [0, 15_000, 30_000], { fromMs: 0, toMs: 30_000 }, false);
    expect(geometry?.paths).toEqual(["M0.00,36.00 M160.00,6.00"]);
    expect(geometry?.gaps).toEqual([]);
  });

  it("hatches the whole sparkline when no value is present", () => {
    const geometry = sparkGeometry([[null, null]], [0, 15_000], { fromMs: 0, toMs: 30_000 }, false);
    expect(geometry?.paths).toEqual([]);
    expect(geometry?.gaps).toEqual([{ x0: 0, x1: 160 }]);
  });

  it("finds the worst value across tracks on one sparkline axis", () => {
    const worst = worstTrack([
      { times: [0, 15_000], values: [1, 5] },
      { times: [0, 15_000], values: [3, 2] }
    ], 15_000);
    expect(worst).toEqual({ times: [0, 15_000], values: [3, 5] });
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
    const windowed = windowTracks([{ times, values: [1, 2, 3, 4] }, { times, values: [5, null, 7, 8] }], { fromMs: 1_500, toMs: 3_000 });
    expect(windowed.map(track => track.values)).toEqual([[2, 3], [null, 7]]);
    expect(windowed[0]!.times).toEqual([2_000, 3_000]);
    expect(windowed[0]!.times).toBe(windowed[1]!.times);
  });

  it("sums series per sample time and leaves times with no value as gaps", () => {
    const totals = sumTracks([
      { times: [1_000, 2_000], values: [4, null] },
      { times: [1_000, 3_000], values: [6, 5] }
    ]);
    expect(totals).toEqual({ times: [1_000, 2_000, 3_000], values: [10, null, 5] });
    const times = [1_000, 2_000, 3_000];
    expect(sumTracks([{ times, values: [1, null, null] }, { times: [...times], values: [2, 3, null] }])).toEqual({ times, values: [3, 3, null] });
    expect(sumTracks([])).toEqual({ times: [], values: [] });
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
