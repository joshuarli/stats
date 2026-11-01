import type { CollectorState, Host } from "./api";
import type { Tone } from "./components/ui";
import { healthOf, LIMITS } from "./health";

export interface HostStatus {
  readonly label: "online" | "stale" | "revoked" | "unknown" | "no samples";
  readonly tone: Tone;
}

export function statusFor(host: Host | undefined, latestAt: number | null): HostStatus {
  if (host === undefined) return { label: "unknown", tone: "warn" };
  if (host.revoked) return { label: "revoked", tone: "bad" };
  if (host.online) return { label: "online", tone: "ok" };
  return latestAt === null ? { label: "no samples", tone: "neutral" } : { label: "stale", tone: "warn" };
}

export interface CollectorStatus {
  readonly label: "collecting" | "waiting" | "stale" | "failing";
  readonly tone: Tone;
}

export function collectorStatus(collector: CollectorState, nowMs: number): CollectorStatus {
  if (collector.lastSuccessAtMs === null) {
    return collector.lastError === null ? { label: "waiting", tone: "warn" } : { label: "failing", tone: "bad" };
  }
  const silentMinutes = Math.max(0, nowMs - collector.lastSuccessAtMs) / 60_000;
  const health = healthOf(silentMinutes, LIMITS.collectorStaleMinutes) ?? "ok";
  if (health === "critical") return { label: collector.lastError === null ? "stale" : "failing", tone: "bad" };
  if (health === "elevated") return { label: collector.lastError === null ? "stale" : "failing", tone: "warn" };
  return collector.lastError === null ? { label: "collecting", tone: "ok" } : { label: "failing", tone: "warn" };
}
