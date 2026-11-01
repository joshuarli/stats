import type { Host } from "./api";
import type { Tone } from "./components/ui";

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
