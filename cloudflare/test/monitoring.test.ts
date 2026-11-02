import { describe, expect, it } from "vitest";
import { monitorState, rebootTimes } from "../src/client/monitoring";

describe("monitor state", () => {
  const limits = { elevated: 70, critical: 90, direction: "above" } as const;
  const minutes = (values: (number | undefined)[]) => values.map((value, index) => ({ atMs: index * 60_000, value }));

  it("reports the latest state of the worst scored series", () => {
    const cpu = monitorState({ limits, series: [minutes([10, 80, 95, 20, 20, 20, 20, 20, 20, 20, 75, 80])], stepMs: 60_000 });
    const disk = monitorState({ limits, series: [minutes([10, 10, 10, 10, 10, 95, 95, 10, 10, 10, 10, 10])], stepMs: 60_000 });
    expect(cpu).toBe("elevated");
    expect(disk).toBe("ok");
  });

  it("has no state without limits or data", () => {
    expect(monitorState({ limits: undefined, series: [minutes([99, 99])], stepMs: 60_000 })).toBeUndefined();
    expect(monitorState({ limits, series: [minutes([undefined, undefined])], stepMs: 60_000 })).toBeUndefined();
  });
});

describe("reboots", () => {
  it("reads a fall in uptime as a reboot and ignores points without it", () => {
    const points = [{ atMs: 1, uptimeMs: 100 }, { atMs: 2, uptimeMs: 200 }, { atMs: 3 }, { atMs: 4, uptimeMs: 30 }, { atMs: 5, uptimeMs: 60 }];
    expect(rebootTimes(points)).toEqual([4]);
    expect(rebootTimes([])).toEqual([]);
  });
});
