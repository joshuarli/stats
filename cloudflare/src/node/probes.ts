import type { InstallationCore } from "../core/installation/installation.ts";
import type { Clock } from "../core/ports.ts";
import type { ProbeFetch } from "../projects/probes.ts";
import { TimerScheduler } from "./ports.ts";

export interface ProbeSchedule {
  stop(): void;
  drain(): Promise<void>;
}

export function nextProbeAtMs(nowMs: number): number {
  return (Math.floor(nowMs / 60_000) + 1) * 60_000;
}

export function scheduleServiceProbes(options: { readonly core: InstallationCore; readonly clock: Clock; readonly fetch: ProbeFetch; readonly failed: (error: unknown) => void }): ProbeSchedule {
  const controller = new AbortController();
  const fetch: ProbeFetch = (url, init) => options.fetch(url, { ...init, signal: AbortSignal.any([init.signal, controller.signal]) });
  const scheduler: TimerScheduler = new TimerScheduler(options.clock, async () => {
    try {
      await options.core.collectServiceProbes(fetch, controller.signal);
    } finally {
      await scheduler.at(nextProbeAtMs(options.clock.now()));
    }
  }, options.failed);
  void scheduler.at(nextProbeAtMs(options.clock.now()));
  return { stop: () => { scheduler.stop(); controller.abort(); }, drain: () => scheduler.drain() };
}
