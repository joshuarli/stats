import { DatabaseSync } from "node:sqlite";
import type { Clock } from "../core/ports.ts";
import { InstallationCore } from "../core/installation/installation.ts";
import { APPLICATION_EVENT_READ_LIMIT } from "../deployments/service-compare.ts";
import { NodeObservations } from "./observations.ts";
import { initializeStore } from "../observe/core/store.ts";
import type { NodeRuntime } from "./runtime.ts";
import { configureSqlite, scheduleCheckpoint } from "./sqlite-policy.ts";
import { NodeApplicationEvents } from "./application.ts";
import { systemClock, TimerScheduler } from "./ports.ts";
import type { ProbeFetch } from "../projects/probes.ts";
import { scheduleServiceProbes } from "./probes.ts";
import { nodeSqlScopes } from "./sql.ts";

export class DatabaseInUseError extends Error {
  override readonly name = "DatabaseInUseError";
}

function lockExclusively(db: DatabaseSync): void {
  try {
    configureSqlite(db);
  } catch (error) {
    db.close();
    if (error instanceof Error && "errcode" in error && (error.errcode === 5 || error.errcode === 6)) throw new DatabaseInUseError("the database is locked by another server");
    throw error;
  }
}

export interface NodeInstallationOptions {
  readonly runtime?: NodeRuntime | undefined;
  readonly release?: string | undefined;
  readonly path: string;
  readonly projects: string;
  readonly clock?: Clock;
  readonly probeFetch?: ProbeFetch;
}

export interface NodeInstallation {
  readonly application: NodeApplicationEvents | undefined;
  readonly core: InstallationCore;
  readonly observe: NodeObservations;
  readonly now: () => number;
  schemaVersion(): number;
  close(): void;
  shutdown(): Promise<void>;
}

export function openNodeInstallation(options: NodeInstallationOptions): NodeInstallation {
  const clock = options.clock ?? systemClock;
  const db = new DatabaseSync(options.path);
  lockExclusively(db);
  const stopCheckpoint = scheduleCheckpoint(db, result => options.runtime?.checkpoint("installation", result));
  let core: InstallationCore;
  const scheduler = new TimerScheduler(clock, () => core.alarm(), error => {
    console.error(JSON.stringify({ event: "alarm_rejected", name: error instanceof Error ? error.name : typeof error }));
  }, ms => options.runtime?.retention("installation", ms));
  let observe: NodeObservations | undefined;
  try {
    const sql = nodeSqlScopes(db, options.runtime?.database("installation", options.path));
    initializeStore(sql.open());
    observe = new NodeObservations(db, options.path, clock, options.runtime);
    const application = options.release === undefined ? undefined : new NodeApplicationEvents(observe, options.release);
    options.runtime?.attachApplication(application);
    core = new InstallationCore(
      {
        sql, clock, monotonic: () => performance.now(), scheduler, operations: application?.operations ?? { invocation: () => {}, operation: () => {} }, probesServices: true,
        readApplicationEvents: async (service, fromMs, toMs) => {
          const events = await observe!.forService(service).external(service, { fromMs, toMs, limit: APPLICATION_EVENT_READ_LIMIT });
          return { events, truncated: events.length >= APPLICATION_EVENT_READ_LIMIT };
        }
      },
      { projects: () => options.projects, deploymentsEnabled: () => false }
    );
    core.initialize();
    void core.armRetention();
    const probes = scheduleServiceProbes({
      core, clock, fetch: options.probeFetch ?? fetch,
      failed: error => { console.error(JSON.stringify({ event: "service_probes_failed", name: error instanceof Error ? error.name : typeof error })); }
    });
    return {
      core,
      application,
      observe,
      now: () => clock.now(),
      schemaVersion: () => Number(db.prepare("SELECT version FROM schema_version LIMIT 1").get()!["version"]),
      async shutdown(): Promise<void> {
        probes.stop();
        scheduler.stop();
        stopCheckpoint();
        await application?.shutdown();
        observe!.close();
        db.close();
      },
      close(): void {
        probes.stop();
        scheduler.stop();
        stopCheckpoint();
        observe!.close();
        db.close();
      }
    };
  } catch (error) {
    scheduler.stop();
    stopCheckpoint();
    observe?.close();
    db.close();
    throw error;
  }
}
