import { describe, expect, it } from "vitest";
import { describeState, duration, findEpisodes as find, healthOf, loadLimits, markersOf, memoryAvailableLimits, type Health } from "../src/client/health";

const minute = 60_000;
const findEpisodes = (healths: readonly (Health | null)[], recoveryMs = minute) => find(healths, healths.map((_, index) => index * minute), recoveryMs);
const above = { elevated: 70, critical: 90, direction: "above" } as const;

describe("health", () => {
  it("classifies values against limits in both directions and never invents a state for gaps", () => {
    expect(healthOf(69.9, above)).toBe("ok");
    expect(healthOf(70, above)).toBe("elevated");
    expect(healthOf(90, above)).toBe("critical");
    expect(healthOf(null, above)).toBeNull();
    expect(healthOf(undefined, above)).toBeNull();
    const memory = memoryAvailableLimits(1000)!;
    expect(healthOf(400, memory)).toBe("ok");
    expect(healthOf(150, memory)).toBe("elevated");
    expect(healthOf(50, memory)).toBe("critical");
    expect(loadLimits(8)).toEqual({ elevated: 8, critical: 16, direction: "above" });
    expect(loadLimits(undefined)).toBeUndefined();
  });

  const sequence: (Health | null)[] = ["ok", "elevated", "elevated", "critical", "ok", "ok", "ok", "elevated", "ok", "elevated", "critical"];

  it("opens an episode on the first elevated sample and closes it only after two ok samples in a row", () => {
    const episodes = findEpisodes(sequence);
    expect(episodes).toEqual([
      { startIndex: 1, endIndex: 4, criticalIndex: 3, peak: "critical", okSince: null },
      { startIndex: 7, endIndex: null, criticalIndex: 10, peak: "critical", okSince: null }
    ]);
  });

  it("treats gaps as neither bad nor recovered", () => {
    expect(findEpisodes(["elevated", null, null, "ok", null, "ok"])).toEqual([{ startIndex: 0, endIndex: 3, criticalIndex: null, peak: "elevated", okSince: null }]);
    expect(findEpisodes(["elevated", null, "ok"])).toEqual([{ startIndex: 0, endIndex: null, criticalIndex: null, peak: "elevated", okSince: 2 }]);
  });

  it("marks where it went bad, where it turned critical, and where it recovered", () => {
    expect(markersOf(findEpisodes(sequence))).toEqual([
      { index: 1, kind: "elevated" },
      { index: 3, kind: "critical" },
      { index: 4, kind: "recovered" },
      { index: 7, kind: "elevated" },
      { index: 10, kind: "critical" }
    ]);
  });

  it("describes the current state with how long it has lasted or when it recovered", () => {
    const times = sequence.map((_, index) => index * 60_000);
    const open = describeState(times, sequence, findEpisodes(sequence))!;
    expect(open.health).toBe("critical");
    expect(open.text).toMatch(/^Critical since .* · 3 min$/u);

    const recovered = sequence.slice(0, 7);
    const closed = describeState(times, recovered, findEpisodes(recovered))!;
    expect(closed.health).toBe("ok");
    expect(closed.text).toMatch(/^OK · recovered .* after 3 min critical$/u);

    const settling: (Health | null)[] = ["elevated", "ok"];
    expect(describeState(times, settling, findEpisodes(settling, 5 * minute))!.text).toMatch(/^OK · recovering since /u);
    expect(describeState(times, ["ok", "ok"], [])!.text).toBe("OK");
    expect(describeState(times, [null, null], [])).toBeUndefined();
  });

  it("keeps a spiky signal in one episode until it has stayed ok for the recovery window", () => {
    const spiky: (Health | null)[] = ["elevated", "ok", "ok", "elevated", "ok", "ok", "ok", "ok", "ok", "ok"];
    expect(findEpisodes(spiky, 4 * minute)).toEqual([{ startIndex: 0, endIndex: 4, criticalIndex: null, peak: "elevated", okSince: null }]);
    expect(findEpisodes(spiky, minute)).toHaveLength(2);
  });

  it("formats durations", () => {
    expect(duration(20_000)).toBe("under 1 min");
    expect(duration(12 * 60_000)).toBe("12 min");
    expect(duration(125 * 60_000)).toBe("2 h 5 min");
    expect(duration(72 * 3_600_000)).toBe("3 d");
  });
});
