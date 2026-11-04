import { DurableObject } from "cloudflare:workers";
import type { Preparation } from "../core/model.ts";
import {
  cleanup, health, ingest, initializeStore, issueOccurrences, listIssues, listTraces, nextCleanupAt, readTrace, setIssueState,
  type Health, type IngestResult, type IssueState, type IssueSummary, type Occurrence, type Page, type SqlDatabase, type SqlValue, type TraceDetail, type TraceFilter, type TraceSummary
} from "../core/store.ts";
import { CLEANUP_INTERVAL_MS } from "../core/limits.ts";

export interface ObserveEnv {
  readonly STORE: DurableObjectNamespace<ObservationStore>;
}

export interface StoreHealth extends Health {
  readonly databaseBytes: number;
}

function sqlDatabase(storage: DurableObjectStorage): SqlDatabase {
  return {
    rows<T>(query: string, ...params: SqlValue[]): T[] {
      return storage.sql.exec(query, ...params).toArray() as T[];
    },
    run(query: string, ...params: SqlValue[]): void {
      storage.sql.exec(query, ...params);
    },
    transaction<T>(fn: () => T): T {
      return storage.transactionSync(fn);
    }
  };
}

export class ObservationStore extends DurableObject<ObserveEnv> {
  private readonly db: SqlDatabase;

  constructor(ctx: DurableObjectState, env: ObserveEnv) {
    super(ctx, env);
    this.db = sqlDatabase(ctx.storage);
    void ctx.blockConcurrencyWhile(async () => { initializeStore(this.db); });
  }

  async ingest(preparations: readonly Preparation[]): Promise<IngestResult> {
    const now = Date.now();
    const result = ingest(this.db, preparations, now);
    if (result.accepted > 0 && await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(now + CLEANUP_INTERVAL_MS);
    return result;
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const cleaned = cleanup(this.db, now);
    const next = nextCleanupAt(this.db, now, cleaned);
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  async ensureCleanup(): Promise<void> {
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now());
  }

  async issues(filter: { readonly state?: IssueState; readonly cursor?: string; readonly limit?: number }): Promise<Page<IssueSummary>> {
    return listIssues(this.db, Date.now(), filter);
  }

  async occurrences(fingerprint: string, filter: { readonly cursor?: string; readonly limit?: number }): Promise<Page<Occurrence>> {
    return issueOccurrences(this.db, Date.now(), fingerprint, filter);
  }

  async setIssueState(fingerprint: string, state: IssueState): Promise<boolean> {
    return setIssueState(this.db, Date.now(), fingerprint, state);
  }

  async traces(filter: TraceFilter): Promise<Page<TraceSummary>> {
    return listTraces(this.db, Date.now(), filter);
  }

  async trace(traceId: string): Promise<TraceDetail | null> {
    return readTrace(this.db, Date.now(), traceId);
  }

  async health(): Promise<StoreHealth> {
    return { ...health(this.db, Date.now()), databaseBytes: this.ctx.storage.sql.databaseSize };
  }
}
