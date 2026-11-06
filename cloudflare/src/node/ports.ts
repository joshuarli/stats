import type { Clock, Scheduler } from "../core/ports.ts";

export const systemClock: Clock = { now: () => Date.now() };

const MAX_TIMER_MS = 2 ** 31 - 1;

export class TimerScheduler implements Scheduler {
  private readonly clock: Clock;
  private readonly fire: () => Promise<void>;
  private readonly failed: (error: unknown) => void;
  private timer: NodeJS.Timeout | null = null;
  private dueMs: number | null = null;
  private stopped = false;

  constructor(clock: Clock, fire: () => Promise<void>, failed: (error: unknown) => void) {
    this.clock = clock;
    this.fire = fire;
    this.failed = failed;
  }

  pending(): Promise<number | null> {
    return Promise.resolve(this.dueMs);
  }

  at(atMs: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.dueMs = atMs;
    this.arm();
    return Promise.resolve();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.dueMs = null;
  }

  private arm(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.dueMs === null) return;
    const wait = Math.min(Math.max(0, this.dueMs - this.clock.now()), MAX_TIMER_MS);
    this.timer = setTimeout(() => this.elapse(), wait);
    this.timer.unref();
  }

  private elapse(): void {
    this.timer = null;
    if (this.dueMs !== null && this.clock.now() < this.dueMs) {
      this.arm();
      return;
    }
    this.dueMs = null;
    this.fire().catch(this.failed);
  }
}
