import { DatabaseSync } from "node:sqlite";
import type { Clock } from "../core/ports.ts";
import { InstallationCore } from "../core/installation/installation.ts";
import { APPLICATION_EVENT_READ_LIMIT } from "../deployments/service-compare.ts";
import { createObserveService, type ObserveService } from "../observe/core/service.ts";
import { initializeStore, KEEP_ALL_COUNTING } from "../observe/core/store.ts";
import type { OperationSink } from "../operations.ts";
import { systemClock, TimerScheduler } from "./ports.ts";
import type { ProbeFetch } from "../projects/probes.ts";
import { scheduleServiceProbes } from "./probes.ts";
import { nodeSqlScopes } from "./sql.ts";

const unobservedOperations: OperationSink = {
  invocation: () => {},
  operation: () => {}
};

export class DatabaseInUseError extends Error {
  override readonly name = "DatabaseInUseError";
}

function lockExclusively(db: DatabaseSync): void {
  try {
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    db.exec("BEGIN IMMEDIATE; COMMIT");
  } catch (error) {
    db.close();
    if (error instanceof Error && "errcode" in error && (error.errcode === 5 || error.errcode === 6)) throw new DatabaseInUseError("the database is locked by another server");
    throw error;
  }
}

export interface NodeInstallationOptions {
  readonly path: string;
  readonly projects: string;
  readonly clock?: Clock;
  readonly probeFetch?: ProbeFetch;
}

export interface NodeInstallation {
  readonly core: InstallationCore;
  readonly observe: ObserveService;
  readonly now: () => number;
  close(): void;
}

export function openNodeInstallation(options: NodeInstallationOptions): NodeInstallation {
  const clock = options.clock ?? systemClock;
  const db = new DatabaseSync(options.path);
  lockExclusively(db);
  let core: InstallationCore;
  const scheduler = new TimerScheduler(clock, () => core.alarm(), error => {
    console.error(JSON.stringify({ event: "alarm_rejected", name: error instanceof Error ? error.name : typeof error }));
  });
  const sql = nodeSqlScopes(db);
  const observe = createObserveService(sql.open(), { now: () => clock.now(), databaseBytes: () => sql.open().databaseBytes() }, () => KEEP_ALL_COUNTING);
  core = new InstallationCore(
    {
      sql, clock, scheduler, operations: unobservedOperations, probesServices: true,
      readApplicationEvents: async (service, fromMs, toMs) => {
        const events = await observe.external(service, { fromMs, toMs, limit: APPLICATION_EVENT_READ_LIMIT });
        return { events, truncated: events.length >= APPLICATION_EVENT_READ_LIMIT };
      }
    },
    { projects: () => options.projects, deploymentsEnabled: () => false }
  );
  core.initialize();
  initializeStore(sql.open());
  void core.armRetention();
  const probes = scheduleServiceProbes({
    core, clock, fetch: options.probeFetch ?? fetch,
    failed: error => { console.error(JSON.stringify({ event: "service_probes_failed", name: error instanceof Error ? error.name : typeof error })); }
  });
  return {
    core,
    observe,
    now: () => clock.now(),
    close(): void {
      probes.stop();
      scheduler.stop();
      db.close();
    }
  };
}
