import { describe, expect, it } from "vitest";
import { placeEvents, type EventCandidate } from "../src/client/components/event-layout";

const measure = (text: string): number => text.length * 6;
const spacing = { minX: 0, maxX: 600, mergePx: 3, padPx: 3 };

function labelled(placed: ReturnType<typeof placeEvents>): (string | null)[] {
  return placed.map(entry => entry.text);
}

describe("event label layout", () => {
  it("labels a lone event in full", () => {
    const placed = placeEvents([{ x: 100, label: "deploy v1.4.0" }], measure, spacing);
    expect(placed).toEqual([{ x: 100, text: "deploy v1.4.0", side: "right", count: 1 }]);
  });

  it("falls back to the short text when the full one would run into the next line", () => {
    const placed = placeEvents([
      { x: 100, label: "deploy v1.2.0 90% / v1.3.0 10%", short: "v1.3.0" },
      { x: 160, label: "deploy v1.3.0" }
    ], measure, spacing);
    expect(labelled(placed)).toEqual(["v1.3.0", "deploy v1.3.0"]);
  });

  it("never lets two drawn labels overlap, however tightly the lines are packed", () => {
    let x = 10;
    const candidates: EventCandidate[] = Array.from({ length: 14 }, (_, index) => {
      x += 8 + (index * 37) % 70;
      return { x, label: `deploy v1.${index}.0`, short: `v1.${index}.0` };
    });
    const placed = placeEvents(candidates, measure, spacing);
    const spans = placed.flatMap(entry => entry.text === null ? [] : [entry.side === "right" ? [entry.x + 3, entry.x + 3 + measure(entry.text)] : [entry.x - 3 - measure(entry.text), entry.x - 3]] as const);
    for (const [index, span] of spans.entries()) {
      const next = spans[index + 1];
      if (next !== undefined) expect(span[1]).toBeLessThanOrEqual(next[0]!);
    }
    expect(placed.some(entry => entry.text === null)).toBe(true);
    expect(placed.some(entry => entry.text !== null)).toBe(true);
  });

  it("merges lines a pixel or two apart into one counted marker", () => {
    const placed = placeEvents([{ x: 300, label: "deploy a" }, { x: 301, label: "deploy b" }, { x: 302, label: "deploy c" }], measure, spacing);
    expect(placed).toEqual([{ x: 300, text: "3 deploys", side: "right", count: 3 }]);
  });

  it("puts the label left of a line that has no room on its right", () => {
    const placed = placeEvents([{ x: 590, label: "deploy v1.4.0" }], measure, spacing);
    expect(placed).toEqual([{ x: 590, text: "deploy v1.4.0", side: "left", count: 1 }]);
  });

  it("keeps the line but drops the text when nothing fits on either side", () => {
    const placed = placeEvents([{ x: 4, label: "deploy v1.4.0" }, { x: 20, label: "deploy v1.5.0" }], measure, spacing);
    expect(labelled(placed)).toEqual([null, "deploy v1.5.0"]);
  });

  it("ignores events outside the plotted area", () => {
    expect(placeEvents([{ x: -5, label: "before" }, { x: 700, label: "after" }], measure, spacing)).toEqual([]);
  });
});
