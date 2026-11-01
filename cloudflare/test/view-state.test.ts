import { createRoot, createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { HOUR_MS, MINUTE_MS, RAW_STEP_MS } from "../src/limits";
import { createViewState, minimumZoomMs, type Range } from "../src/client/state";

const now = 1_800_000_000_000;

function state() {
  const [range] = createSignal<Range>("1h");
  return createRoot(() => createViewState(range, () => now));
}

describe("view state", () => {
  it("derives the zoom floor from the tier the window reads", () => {
    expect(minimumZoomMs(now - 60_000, now)).toBe(2 * RAW_STEP_MS);
    expect(minimumZoomMs(now - 3 * 24 * HOUR_MS, now)).toBe(2 * MINUTE_MS);
    expect(minimumZoomMs(now - 30 * 24 * HOUR_MS, now)).toBe(2 * HOUR_MS);
  });

  it("rejects a selection below the current tier's floor", () => {
    const view = state();
    expect(view.zoomTo({ fromMs: now - 10_000, toMs: now })).toBe(false);
    expect(view.view()).toBeNull();
    expect(view.live()).toBe(true);
  });

  it("returns to live after zooming out to the preset range", () => {
    const view = state();
    expect(view.zoomTo({ fromMs: now - 600_000, toMs: now - 300_000 })).toBe(true);
    expect(view.live()).toBe(false);
    expect(view.view()).not.toBeNull();
    view.zoomOut();
    expect(view.view()).toBeNull();
    expect(view.live()).toBe(true);
    expect(view.canZoomOut()).toBe(false);
  });

  it("restores a paused view after zooming out", () => {
    const view = state();
    view.toggleLive();
    expect(view.live()).toBe(false);
    expect(view.view()).toBeNull();
    expect(view.zoomTo({ fromMs: now - 60_000, toMs: now - 30_000 })).toBe(true);
    view.zoomOut();
    expect(view.view()).toBeNull();
    expect(view.live()).toBe(false);
  });
});
