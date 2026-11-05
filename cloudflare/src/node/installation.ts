import { DatabaseSync } from "node:sqlite";
import type { Clock } from "../core/ports.ts";
import { InstallationCore } from "../core/installation/installation.ts";
import type { OperationSink } from "../operations.ts";
import { systemClock, TimerScheduler } from "./ports.ts";
import { nodeSqlScopes } from "./sql.ts";

const unobservedOperations: OperationSink = {
  invocation: () => {},
  operation: () => {}
};

export interface NodeInstallationOptions {
  readonly path: string;
  readonly projects: string;
  readonly clock?: Clock;
}

export interface NodeInstallation {
  readonly core: InstallationCore;
  close(): void;
}

export function openNodeInstallation(options: NodeInstallationOptions): NodeInstallation {
  const clock = options.clock ?? systemClock;
  const db = new DatabaseSync(options.path);
  const scheduler = new TimerScheduler(clock, () => core.alarm(), error => {
    console.error(JSON.stringify({ event: "alarm_rejected", name: error instanceof Error ? error.name : typeof error }));
  });
  const core = new InstallationCore(
    { sql: nodeSqlScopes(db), clock, scheduler, operations: unobservedOperations },
    { projects: () => options.projects, deploymentsEnabled: () => false }
  );
  core.initialize();
  void core.armRetention();
  return {
    core,
    close(): void {
      scheduler.stop();
      db.close();
    }
  };
}
