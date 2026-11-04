import type { Deployment } from "../../../deployments/model";
import type { TimeWindow } from "../../chart-data";
import { MINUTE_MS, HOUR_MS } from "../../../limits";

const MIN_PAD_MS = 10 * MINUTE_MS;
const MAX_PAD_MS = 6 * HOUR_MS;

/**
 * A deployment is in effect until the next one replaces it; the newest is still in effect now.
 * The window pads both sides so the change from before is visible, and is never shorter than `minSpanMs`.
 */
export function rolloutWindow(deployments: readonly Deployment[], target: Deployment, nowMs: number, minSpanMs: number): TimeWindow {
  const replacedAt = deployments.reduce((earliest, candidate) => candidate.atMs > target.atMs && candidate.atMs < earliest ? candidate.atMs : earliest, nowMs);
  const endMs = Math.max(replacedAt, target.atMs);
  const pad = Math.min(MAX_PAD_MS, Math.max(MIN_PAD_MS, (endMs - target.atMs) / 4));
  const toMs = Math.min(nowMs, endMs + pad);
  const fromMs = Math.min(target.atMs - pad, toMs - minSpanMs);
  return { fromMs, toMs };
}
