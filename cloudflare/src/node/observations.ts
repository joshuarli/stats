import { createHash } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Clock } from "../core/ports.ts";
import type { SqlValue } from "../core/sql.ts";
import { GROUPING_VERSION } from "../observe/core/grouping.ts";
import { createObserveService, type MaintainedService } from "../observe/core/service.ts";
import { initializeStore } from "../observe/core/store.ts";
import { SERVICE_SLUG, type ExternalEvent } from "../observe/ingest/model.ts";
import { TimerScheduler } from "./ports.ts";
import { nodeSqlScopes } from "./sql.ts";

const MAX_OPEN_STORES = 256;
const MAINTENANCE_MS = 3_600_000;

export class NodeObservations {
  private readonly stores = new Map<string, { db: DatabaseSync; service: MaintainedService }>();
  private readonly scheduler: TimerScheduler;
  private readonly directory: string;

  private readonly legacy: DatabaseSync;
  private readonly clock: Clock;

  constructor(legacy: DatabaseSync, path: string, clock: Clock) {
    this.legacy = legacy;
    this.clock = clock;
    this.directory = `${path}.observe`;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.scheduler = new TimerScheduler(clock, async () => this.maintain(), error => {
      console.error(JSON.stringify({ event: "observe_cleanup_failed", name: error instanceof Error ? error.name : typeof error }));
      void this.scheduler.at(clock.now() + MAINTENANCE_MS);
    });
    try {
      for (const file of readdirSync(this.directory)) {
        if (file.endsWith(".sqlite") && SERVICE_SLUG.test(file.slice(0, -7))) this.forService(file.slice(0, -7));
      }
      for (const row of legacy.prepare("SELECT DISTINCT service FROM observe_external_events").all() as { service: string }[]) {
        if (SERVICE_SLUG.test(row.service)) this.forService(row.service);
      }
      this.maintain();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  forService(name: string): MaintainedService {
    if (!SERVICE_SLUG.test(name)) throw new RangeError("invalid observation service");
    const prior = this.stores.get(name);
    if (prior !== undefined) return prior.service;
    if (this.stores.size >= MAX_OPEN_STORES) throw new RangeError("Node supports at most 256 observation stores");
    const db = new DatabaseSync(join(this.directory, `${name}.sqlite`));
    try {
      db.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN IMMEDIATE; COMMIT");
      const sql = nodeSqlScopes(db).open();
      initializeStore(sql);
      this.migrate(db, name);
      const maintained = createObserveService(sql, { now: () => this.clock.now(), databaseBytes: () => sql.databaseBytes() });
      const requireOwner = (service: string): void => { if (service !== name) throw new RangeError("observation service does not own this store"); };
      const service: MaintainedService = {
        ...maintained,
        ingestExternal: (service, events) => { requireOwner(service); return maintained.ingestExternal(name, events); },
        external: (service, filter) => { requireOwner(service); return maintained.external(name, filter); },
        externalOperations: (service, filter) => { requireOwner(service); return maintained.externalOperations(name, filter); }
      };
      this.stores.set(name, { db, service });
      void this.scheduler.at(this.clock.now());
      return service;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private migrate(target: DatabaseSync, name: string): void {
    target.exec("CREATE TABLE IF NOT EXISTS node_observe_migration (id INTEGER PRIMARY KEY CHECK (id = 1))");
    if (target.prepare("SELECT id FROM node_observe_migration").get() !== undefined) return;
    const exists = this.legacy.prepare("SELECT name FROM sqlite_master WHERE name = 'observe_external_events'").get();
    target.exec("BEGIN IMMEDIATE");
    try {
      if (exists !== undefined) {
        const copy = (table: string, rows: Record<string, SqlValue>[]): void => {
          for (const row of rows) {
            const columns = Object.keys(row);
            target.prepare(`INSERT OR IGNORE INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...columns.map(column => row[column]!));
          }
        };
        const events = this.legacy.prepare("SELECT * FROM observe_external_events WHERE service = ?").all(name) as Record<string, SqlValue>[];
        copy("observe_external_events", events);
        const fingerprints = new Set<string>();
        for (const row of events) {
          const event = JSON.parse(String(row["payload"])) as ExternalEvent;
          if (event.error === undefined) continue;
          fingerprints.add(createHash("sha256").update([GROUPING_VERSION, "application", name, event.operation, event.error.code].join("\u0000")).digest("hex"));
        }
        for (const fingerprint of fingerprints) {
          copy("observe_issues", this.legacy.prepare("SELECT * FROM observe_issues WHERE fingerprint = ?").all(fingerprint) as Record<string, SqlValue>[]);
          copy("observe_occurrences", this.legacy.prepare("SELECT * FROM observe_occurrences WHERE fingerprint = ? AND source = 'application'").all(fingerprint) as Record<string, SqlValue>[]);
        }
        copy("observe_ingest_windows", this.legacy.prepare("SELECT * FROM observe_ingest_windows WHERE service = ?").all(name) as Record<string, SqlValue>[]);
      }
      target.exec("INSERT INTO node_observe_migration VALUES (1); COMMIT");
    } catch (error) {
      target.exec("ROLLBACK");
      throw error;
    }
  }

  private maintain(): void {
    let next = this.clock.now() + MAINTENANCE_MS;
    for (const { service } of this.stores.values()) {
      const result = service.cleanup();
      if (result.nextAtMs !== null) next = Math.min(next, result.nextAtMs);
    }
    void this.scheduler.at(next);
  }

  close(): void {
    this.scheduler.stop();
    for (const { db } of this.stores.values()) db.close();
    this.stores.clear();
  }
}
