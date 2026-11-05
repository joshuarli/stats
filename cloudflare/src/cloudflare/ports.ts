import type { Clock, Scheduler } from "../core/ports.ts";

export function cloudflareClock(env: { readonly ENVIRONMENT?: string; readonly TEST_NOW_MS?: string }): Clock {
  return {
    now(): number {
      if (env.ENVIRONMENT === "test" && env.TEST_NOW_MS !== undefined) {
        const value = Number(env.TEST_NOW_MS);
        if (Number.isSafeInteger(value) && value >= 0) return value;
      }
      return Date.now();
    }
  };
}

export function cloudflareScheduler(storage: Pick<DurableObjectStorage, "getAlarm" | "setAlarm">): Scheduler {
  return {
    pending: () => storage.getAlarm(),
    at: atMs => storage.setAlarm(atMs)
  };
}
