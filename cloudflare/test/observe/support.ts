import { DatabaseSync } from "node:sqlite";
import type { SqlDatabase, SqlValue } from "../../src/observe/core/store.ts";
import { initializeStore } from "../../src/observe/core/store.ts";
import type { ObservedInvocation, Preparation, PreparedInvocation } from "../../src/observe/core/model.ts";

export interface TestDatabase extends SqlDatabase {
  readonly db: DatabaseSync;
  failOnRun: ((query: string) => boolean) | null;
}

export function database(): TestDatabase {
  const store = wrap(new DatabaseSync(":memory:"));
  initializeStore(store);
  return store;
}

export function wrap(db: DatabaseSync): TestDatabase {
  let written = 0;
  const store: TestDatabase = {
    db,
    failOnRun: null,
    rows<T>(query: string, ...params: SqlValue[]): T[] {
      return db.prepare(query).all(...params) as T[];
    },
    run(query: string, ...params: SqlValue[]): void {
      if (store.failOnRun?.(query) === true) throw new Error("injected write failure");
      written += Number(db.prepare(query).run(...params).changes);
    },
    rowsWritten(): number {
      return written;
    },
    transaction<T>(fn: () => T): T {
      db.exec("BEGIN");
      try {
        const value = fn();
        db.exec("COMMIT");
        return value;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  };
  return store;
}

export const T0 = Date.UTC(2026, 10, 3, 12);
export const H = 3_600_000;
export const D = 24 * H;

export const hex = (n: number, width: number): string => n.toString(16).padStart(width, "0");
export const traceId = (n: number): string => hex(n + 1, 32);
export const spanId = (n: number): string => hex(n + 1, 16);
export const OBJECT = "71437be8483ec4c778560417396a6e8e81f1673f27ec5d341ec7a2645e467eb9";
export const VERSION = "3172128e-5c58-48a4-8c16-7767d5521979";

export const DO_STACK = "    at failB (../../../../../../src/index.ts:15:13)\n    at Store.fetch (../../../../../../src/index.ts:36:34)";
export const BUNDLE_STACK = "AppError: cause a token=SECRET_IN_MESSAGE\n    at failA (index.js:183:27)\n    at Object.fetch (index.js:1130:15)";

export function worker(n: number, overrides: Partial<ObservedInvocation> = {}): ObservedInvocation {
  return {
    version: VERSION, stage: "worker", objectId: null, kind: "fetch", label: "GET /api/v1/hosts", status: 200, outcome: "ok",
    cpuMs: 2, wallMs: 40, eventAtMs: T0, trace: { traceId: traceId(n), spanId: spanId(n * 4) }, errors: [], ...overrides
  };
}

export function object(n: number, overrides: Partial<ObservedInvocation> = {}): ObservedInvocation {
  return {
    ...worker(n), stage: "object", objectId: OBJECT, kind: "rpc", label: "Installation.ingest", status: null,
    trace: { traceId: traceId(n), spanId: spanId(n * 4 + 1) }, eventAtMs: T0 + 1, ...overrides
  };
}

export function synthetic(n: number, atMs: number, failed = false): Preparation {
  const invocation: PreparedInvocation = {
    key: hex(n + 1, 16), digest: hex(n + 1, 64), version: VERSION, stage: "worker", objectId: null, kind: "fetch", label: "POST /ingest/v1/batches",
    status: failed ? 500 : 204, outcome: "ok", cpuMs: 3, wallMs: 60, eventAtMs: atMs, trace: { traceId: hex(n + 1, 32), spanId: hex(n + 1, 16) }, errorCount: 0, errors: [],
    keySource: "span"
  };
  return { ok: true, invocation };
}
