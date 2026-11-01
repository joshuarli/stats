import { describe, expect, it } from "vitest";
import { forecastFull, forecastHealth, forecastText } from "../src/client/forecast";
import { incidentsNewestFirst, monitorOne, rebootTimes, worstHealth, type Monitor } from "../src/client/incidents";

const hour = 3_600_000;

describe("disk-full forecast", () => {
  const filling = (perDay: number, hours = 48, available = 500) => Array.from({ length: hours }, (_, index) => ({ atMs: index * hour, total: 1000, available: available - (perDay * index) / 24 }));

  it("projects a steady climb to the day usage reaches the top", () => {
    const forecast = forecastFull(filling(10));
    expect(forecast.kind).toBe("filling");
    if (forecast.kind === "filling") {
      expect(forecast.bytesPerDay).toBeCloseTo(10, 6);
      expect(forecast.daysToFull).toBeCloseTo((500 - (10 * 47) / 24) / 10, 3);
    }
    expect(forecastText(forecast, value => `${value.toFixed(0)}B`)).toMatch(/^full in 48 d · \+10B\/day$/u);
  });

  it("calls a flat, shrinking, or barely moving disk stable", () => {
    expect(forecastFull(filling(0)).kind).toBe("stable");
    expect(forecastFull(filling(-30)).kind).toBe("stable");
    expect(forecastFull(filling(0.2)).kind).toBe("stable");
  });

  it("refuses to guess from too little history", () => {
    expect(forecastFull(filling(10, 4)).kind).toBe("unknown");
    expect(forecastFull([]).kind).toBe("unknown");
    expect(forecastFull(Array.from({ length: 10 }, () => ({ atMs: 5, total: 1000, available: 500 }))).kind).toBe("unknown");
    expect(forecastFull(filling(10).map(point => ({ ...point, total: 0 }))).kind).toBe("unknown");
  });

  it("raises the state as the projected date nears", () => {
    expect(forecastHealth(forecastFull(filling(100)))).toBe("critical");
    expect(forecastHealth(forecastFull(filling(25)))).toBe("elevated");
    expect(forecastHealth(forecastFull(filling(2)))).toBe("ok");
    expect(forecastHealth(forecastFull(filling(0)))).toBe("ok");
    expect(forecastHealth({ kind: "unknown" })).toBeUndefined();
  });
});

describe("incidents", () => {
  const limits = { elevated: 70, critical: 90, direction: "above" } as const;
  const minutes = (values: (number | undefined)[]) => values.map((value, index) => ({ atMs: index * 60_000, value }));
  const monitor = (id: string, values: (number | undefined)[]): Monitor => ({ id, label: id.toUpperCase(), anchor: id, limits, series: [minutes(values)], stepMs: 60_000 });

  it("lists each bad period with its peak and when it ended, newest first", () => {
    const cpu = monitorOne(monitor("cpu", [10, 80, 95, 20, 20, 20, 20, 20, 20, 20, 75, 80]));
    const disk = monitorOne(monitor("disk", [10, 10, 10, 10, 10, 95, 95, 10, 10, 10, 10, 10, 10, 10, 10]));
    const found = incidentsNewestFirst([cpu, disk], 10);
    expect(found.map(entry => [entry.monitor, entry.peak, entry.startMs, entry.endMs])).toEqual([
      ["cpu", "elevated", 600_000, null],
      ["disk", "critical", 300_000, 420_000],
      ["cpu", "critical", 60_000, 180_000]
    ]);
    expect(cpu.state?.health).toBe("elevated");
    expect(disk.state?.health).toBe("ok");
    expect(worstHealth([cpu, disk])).toBe("elevated");
  });

  it("has nothing to say without limits or data", () => {
    const none = monitorOne({ ...monitor("x", [99, 99]), limits: undefined });
    expect(none.incidents).toEqual([]);
    expect(none.state).toBeUndefined();
    expect(worstHealth([none])).toBeUndefined();
    expect(incidentsNewestFirst([], 5)).toEqual([]);
  });
});

describe("reboots", () => {
  it("reads a fall in uptime as a reboot and ignores points without it", () => {
    const points = [{ atMs: 1, uptimeMs: 100 }, { atMs: 2, uptimeMs: 200 }, { atMs: 3 }, { atMs: 4, uptimeMs: 30 }, { atMs: 5, uptimeMs: 60 }];
    expect(rebootTimes(points)).toEqual([4]);
    expect(rebootTimes([])).toEqual([]);
  });
});
