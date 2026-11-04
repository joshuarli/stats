import { describe, expect, it } from "vitest";
import { rolloutWindow } from "../src/client/pages/project/rollout";
import type { Deployment } from "../src/deployments/model";

const HOUR = 3_600_000;
const NOW = 100 * HOUR;

function deployment(id: string, atMs: number): Deployment {
  return { id, atMs, source: "wrangler", message: null, versions: [{ id: `${id}-version`, percentage: 100 }], deferred: false };
}

const newest = deployment("c", 90 * HOUR);
const middle = deployment("b", 60 * HOUR);
const oldest = deployment("a", 10 * HOUR);
const history = [newest, middle, oldest];

describe("rollout window", () => {
  it("runs a replaced deployment until the next one, with context on both sides", () => {
    const window = rolloutWindow(history, middle, NOW, HOUR);
    expect(window.fromMs).toBeLessThan(middle.atMs);
    expect(window.toMs).toBeGreaterThan(newest.atMs);
    expect(window.toMs).toBeLessThanOrEqual(NOW);
  });

  it("runs the newest deployment to now and never past it", () => {
    const window = rolloutWindow(history, newest, NOW, HOUR);
    expect(window.toMs).toBe(NOW);
    expect(window.fromMs).toBeLessThan(newest.atMs);
  });

  it("does not depend on the order the history arrives in", () => {
    expect(rolloutWindow([oldest, newest, middle], middle, NOW, HOUR)).toEqual(rolloutWindow(history, middle, NOW, HOUR));
  });

  it("widens a rollout that was superseded within minutes to the minimum span", () => {
    const quick = deployment("q", 50 * HOUR);
    const window = rolloutWindow([newest, deployment("r", 50 * HOUR + 120_000), quick], quick, NOW, 2 * HOUR);
    expect(window.toMs - window.fromMs).toBeGreaterThanOrEqual(2 * HOUR);
    expect(window.fromMs).toBeLessThan(quick.atMs);
  });

  it("keeps the minimum span for a deployment made moments ago without reaching past now", () => {
    const fresh = deployment("f", NOW - 60_000);
    const window = rolloutWindow([fresh], fresh, NOW, HOUR);
    expect(window.toMs).toBe(NOW);
    expect(window.toMs - window.fromMs).toBeGreaterThanOrEqual(HOUR);
  });
});
