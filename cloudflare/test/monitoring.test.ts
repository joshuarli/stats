import { describe, expect, it } from "vitest";
import type { Track } from "../src/client/columns";
import { monitorState, rebootTimes } from "../src/client/monitoring";

describe("monitor state", () => {
  const limits = { elevated: 70, critical: 90, direction: "above" } as const;
  const minutes = (values: (number | null)[]): Track => ({ times: values.map((_, index) => index * 60_000), values });

  it("reports the latest state of the worst scored series", () => {
    const cpu = monitorState({ limits, series: [minutes([10, 80, 95, 20, 20, 20, 20, 20, 20, 20, 75, 80])], stepMs: 60_000 });
    const disk = monitorState({ limits, series: [minutes([10, 10, 10, 10, 10, 95, 95, 10, 10, 10, 10, 10])], stepMs: 60_000 });
    expect(cpu).toBe("elevated");
    expect(disk).toBe("ok");
  });

  it("has no state without limits or data", () => {
    expect(monitorState({ limits: undefined, series: [minutes([99, 99])], stepMs: 60_000 })).toBeUndefined();
    expect(monitorState({ limits, series: [minutes([null, null])], stepMs: 60_000 })).toBeUndefined();
  });
});

describe("reboots", () => {
  it("reads a fall in uptime as a reboot and ignores rows without it", () => {
    expect(rebootTimes([1, 2, 3, 4, 5], [100, 200, null, 30, 60])).toEqual([4]);
    expect(rebootTimes([], [])).toEqual([]);
  });
});
