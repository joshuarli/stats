import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tokenHash } from "../../src/auth.ts";
import type { Clock } from "../../src/core/ports.ts";
import { InstallationCore } from "../../src/core/installation/installation.ts";
import { INGEST_MEDIA_TYPE } from "../../src/ingest/http.ts";
import type { SourceBatch } from "../../src/ingest/encode.ts";
import type { OperationSink } from "../../src/operations.ts";
import { TimerScheduler } from "../../src/node/ports.ts";
import { nodeSqlScopes } from "../../src/node/sql.ts";

export const ROOT = resolve(import.meta.dirname, "../..");
export const FIXTURES = resolve(ROOT, "../fixtures/v2");
export const SCRATCH = resolve(ROOT, "../.work/tmp");
export const NOW_MS = 1_793_510_415_000;
export const DAY_MS = 86_400_000;

export interface ManifestBatch {
  readonly name: string;
  readonly frame: string;
  readonly source: string;
  readonly samples: readonly ("accept" | "invalid_sample")[];
}

export const manifest = JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8")) as { batches: ManifestBatch[] };

export function fixtureBytes(relative: string): Uint8Array<ArrayBuffer> {
  const bytes = readFileSync(join(FIXTURES, relative));
  return Uint8Array.from(bytes);
}

export function fixtureSource(relative: string): SourceBatch {
  return JSON.parse(readFileSync(join(FIXTURES, relative), "utf8")) as SourceBatch;
}

export function withHost(frame: Uint8Array<ArrayBuffer>, hostId: string): Uint8Array<ArrayBuffer> {
  const copy = frame.slice();
  for (let index = 0; index < 16; index += 1) copy[6 + index] = Number.parseInt(hostId.slice(2 + index * 2, 4 + index * 2), 16);
  return copy;
}

export function scratchDirectory(name: string): string {
  mkdirSync(SCRATCH, { recursive: true });
  const directory = join(SCRATCH, `${name}-${process.pid}-${Date.now()}`);
  mkdirSync(directory);
  return directory;
}

export function ingestRequest(token: string, body: Uint8Array<ArrayBuffer>): Request {
  return new Request("https://installation/ingest", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": INGEST_MEDIA_TYPE }, body });
}

export function historyRequest(hostId: string, search: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://installation/hosts/${hostId}/history?${search}`, { headers });
}

const unobserved: OperationSink = { invocation: () => {}, operation: () => {} };

export interface Harness {
  readonly core: InstallationCore;
  readonly db: DatabaseSync;
  readonly scheduler: TimerScheduler;
  setNow(ms: number): void;
  adoptHost(hostId: string, token: string, name: string): Promise<void>;
  close(): void;
}

export function openHarness(projects = "[]", options: { readonly probesServices: boolean } = { probesServices: false }): Harness {
  let nowMs = NOW_MS;
  const clock: Clock = { now: () => nowMs };
  const db = new DatabaseSync(":memory:");
  const scheduler = new TimerScheduler(clock, () => core.alarm(), error => { throw error; });
  const core = new InstallationCore(
    { sql: nodeSqlScopes(db), clock, scheduler, operations: unobserved, probesServices: options.probesServices },
    { projects: () => projects, deploymentsEnabled: () => false }
  );
  core.initialize();
  return {
    core,
    db,
    scheduler,
    setNow: ms => { nowMs = ms; },
    async adoptHost(hostId, token, name) {
      db.prepare("INSERT INTO hosts (host_id, name, token_hash, created_at_ms) VALUES (?, ?, ?, ?)").run(hostId, name, await tokenHash(token), nowMs);
    },
    close() {
      scheduler.stop();
      db.close();
    }
  };
}
