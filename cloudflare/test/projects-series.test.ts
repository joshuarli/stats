import { describe, expect, it } from "vitest";
import type { Track } from "../src/client/columns";
import { holdLast, ratio } from "../src/client/math.ts";

const MINUTE = 60_000;
const track = (times: number[], values: (number | null)[]): Track => ({ times, values });

describe("project series", () => {
  it("holds a gauge for one hour after its last report and then lets it lapse", () => {
    const held = holdLast(track([0, 10, 20, 30, 60, 70, 80].map(minutes => minutes * MINUTE), [5, null, null, null, null, null, null]));
    expect(held.values).toEqual([5, 5, 5, 5, 5, null, null]);
  });

  it("starts holding only after the first report", () => {
    expect(holdLast(track([0, MINUTE, 2 * MINUTE], [null, 3, null])).values).toEqual([null, 3, 3]);
  });

  it("leaves a share absent when there is nothing to divide by or nothing known", () => {
    const times = [0, 1, 2, 3];
    expect(ratio(track(times, [1, 0, 5, null]), track(times, [10, 0, null, 20]), 100).values).toEqual([10, null, null, null]);
  });

  it("does not score a share from a bucket with fewer events than the minimum", () => {
    const times = [0, 1, 2];
    const part = track(times, [50, 50, 50]);
    const whole = track(times, [99, 100, 1000]);
    expect(ratio(part, whole, 100, 100).values).toEqual([null, 50, 5]);
    expect(ratio(part, whole, 100).values[0]).toBeCloseTo(50.5, 1);
  });

  it("treats a missing part as unknown", () => {
    expect(ratio(track([], []), track([0, 1], [10, 10]), 100).values).toEqual([null, null]);
  });
});
