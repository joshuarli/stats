import { DatabaseSync } from "node:sqlite";
import type { Clock } from "../core/ports.ts";
import { InstallationCore } from "../core/installation/installation.ts";
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
  close(): void;
}

export function openNodeInstallation(options: NodeInstallationOptions): NodeInstallation {
  const clock = options.clock ?? systemClock;
  const db = new DatabaseSync(options.path);
  lockExclusively(db);
  const scheduler = new TimerScheduler(clock, () => core.alarm(), error => {
    console.error(JSON.stringify({ event: "alarm_rejected", name: error instanceof Error ? error.name : typeof error }));
  });
  const core = new InstallationCore(
    { sql: nodeSqlScopes(db), clock, scheduler, operations: unobservedOperations },
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
    close(): void {
      probes.stop();
      scheduler.stop();
      db.close();
    }
  };
}
