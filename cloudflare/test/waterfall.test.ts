import { describe, expect, it } from "vitest";
import { axisTicks, place, type Axis } from "../src/client/waterfall";

const axis = (from: number, to: number): Axis => ({ from, to, format: String });

describe("waterfall axis", () => {
  it("puts ticks on round values inside the span", () => {
    expect(axisTicks(0, 0.46)).toEqual([0, 0.2, 0.4]);
    expect(axisTicks(0, 100)).toEqual([0, 50, 100]);
    expect(axisTicks(0, 80)).toEqual([0, 20, 40, 60, 80]);
  });

  it("starts ticks at the first round value after a panned origin", () => {
    expect(axisTicks(-0.3, 1.3)).toEqual([0, 0.5, 1]);
  });

  it("keeps a degenerate span to one tick instead of looping", () => {
    expect(axisTicks(5, 5)).toEqual([5]);
  });

  it("clips bars to the visible window and hides bars outside it", () => {
    expect(place(2, 6, axis(0, 10))).toEqual({ left: 20, width: 40, clippedStart: false, clippedEnd: false });
    expect(place(-5, 5, axis(0, 10))).toEqual({ left: 0, width: 50, clippedStart: true, clippedEnd: false });
    expect(place(8, 20, axis(0, 10))).toEqual({ left: 80, width: 20, clippedStart: false, clippedEnd: true });
    expect(place(11, 12, axis(0, 10))).toBeNull();
    expect(place(-3, -1, axis(0, 10))).toBeNull();
  });
});
