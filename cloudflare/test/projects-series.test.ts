import { describe, expect, it } from "vitest";
import { holdLast, ratio } from "../src/client/pages/project/math";

const MINUTE = 60_000;

describe("project series", () => {
  it("holds a gauge for one hour after its last report and then lets it lapse", () => {
    const points = [0, 10, 20, 30, 60, 70, 80].map((minutes, index) => ({ atMs: minutes * MINUTE, value: index === 0 ? 5 : undefined }));
    expect(holdLast(points).map((point) => point.value)).toEqual([5, 5, 5, 5, 5, undefined, undefined]);
  });

  it("starts holding only after the first report", () => {
    const points = [{ atMs: 0, value: undefined }, { atMs: MINUTE, value: 3 }, { atMs: 2 * MINUTE, value: undefined }];
    expect(holdLast(points).map((point) => point.value)).toEqual([undefined, 3, 3]);
  });

  it("leaves a share absent when there is nothing to divide by or nothing known", () => {
    const whole = [10, 0, undefined, 20].map((value, index) => ({ atMs: index, value }));
    const part = [1, 0, 5, undefined].map((value, index) => ({ atMs: index, value }));
    expect(ratio(part, whole, 100).map((point) => point.value)).toEqual([10, undefined, undefined, undefined]);
  });
});
