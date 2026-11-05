import type { InstallationCore } from "../core/installation/installation.ts";
import type { Clock } from "../core/ports.ts";
import { BUCKET_MS } from "../projects/queries.ts";
import type { ProbeFetch } from "../projects/probes.ts";
import { TimerScheduler } from "./ports.ts";

export interface ProbeSchedule {
  stop(): void;
}

export function nextProbeAtMs(nowMs: number): number {
  return (Math.floor(nowMs / BUCKET_MS) + 1) * BUCKET_MS;
}

export function scheduleServiceProbes(options: { readonly core: InstallationCore; readonly clock: Clock; readonly fetch: ProbeFetch; readonly failed: (error: unknown) => void }): ProbeSchedule {
  const scheduler: TimerScheduler = new TimerScheduler(options.clock, async () => {
    try {
      await options.core.collectServiceProbes(options.fetch);
    } finally {
      await scheduler.at(nextProbeAtMs(options.clock.now()));
    }
  }, options.failed);
  void scheduler.at(nextProbeAtMs(options.clock.now()));
  return { stop: () => scheduler.stop() };
}
