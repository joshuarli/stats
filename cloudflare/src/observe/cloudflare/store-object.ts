import { DurableObject } from "cloudflare:workers";
import type { Artifact, ObservedRollout, Preparation, VersionLabel } from "../core/model.ts";
import { initializeStore, type Exploration, type IngestResult, type IssueState, type IssueSummary, type Occurrence, type Page, type RolloutImpact, type RolloutResult, type SqlDatabase, type SqlValue, type TraceDetail, type TraceFilter, type TraceSummary } from "../core/store.ts";
import { createObserveService, type ArtifactOutcome, type MaintainedService, type ObserveService, type ServiceHealth } from "../core/service.ts";
import { CLEANUP_INTERVAL_MS } from "../core/limits.ts";

export interface ObserveEnv {
  readonly STORE: DurableObjectNamespace<ObservationStore>;
}

function sqlDatabase(storage: DurableObjectStorage): SqlDatabase {
  let written = 0;
  return {
    rows<T>(query: string, ...params: SqlValue[]): T[] {
      return storage.sql.exec(query, ...params).toArray() as T[];
    },
    run(query: string, ...params: SqlValue[]): void {
      const cursor = storage.sql.exec(query, ...params);
      cursor.toArray();
      written += cursor.rowsWritten;
    },
    rowsWritten(): number {
      return written;
    },
    transaction<T>(fn: () => T): T {
      return storage.transactionSync(fn);
    }
  };
}

export class ObservationStore extends DurableObject<ObserveEnv> implements ObserveService {
  private readonly service: MaintainedService;

  constructor(ctx: DurableObjectState, env: ObserveEnv) {
    super(ctx, env);
    const db = sqlDatabase(ctx.storage);
    this.service = createObserveService(db, { now: () => Date.now(), databaseBytes: () => ctx.storage.sql.databaseSize });
    void ctx.blockConcurrencyWhile(async () => { initializeStore(db); });
  }

  async ingest(preparations: readonly Preparation[]): Promise<IngestResult> {
    const result = this.service.ingest(preparations);
    if (result.accepted > 0 && await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + CLEANUP_INTERVAL_MS);
    return result;
  }

  override async alarm(): Promise<void> {
    const { nextAtMs } = this.service.cleanup();
    if (nextAtMs !== null) await this.ctx.storage.setAlarm(nextAtMs);
  }

  async ensureCleanup(): Promise<void> {
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now());
  }

  async rollouts(rollouts: readonly ObservedRollout[], labels: readonly VersionLabel[]): Promise<RolloutResult> { return this.service.rollouts(rollouts, labels); }
  async impact(rolloutId: string): Promise<RolloutImpact | null> { return this.service.impact(rolloutId); }
  async issues(filter: { readonly state?: IssueState; readonly introducedIn?: string; readonly cursor?: string; readonly limit?: number }): Promise<Page<IssueSummary>> { return this.service.issues(filter); }
  async issue(fingerprint: string): Promise<IssueSummary | null> { return this.service.issue(fingerprint); }
  async occurrences(fingerprint: string, filter: { readonly cursor?: string; readonly limit?: number }): Promise<Page<Occurrence>> { return this.service.occurrences(fingerprint, filter); }
  async setIssueState(fingerprint: string, state: IssueState): Promise<boolean> { return this.service.setIssueState(fingerprint, state); }
  async explore(filter: { readonly fromMs?: number; readonly toMs?: number; readonly route?: string }): Promise<Exploration> { return this.service.explore(filter); }
  async traces(filter: TraceFilter): Promise<Page<TraceSummary>> { return this.service.traces(filter); }
  async trace(traceId: string): Promise<TraceDetail | null> { return this.service.trace(traceId); }
  async health(): Promise<ServiceHealth> { return this.service.health(); }
  async artifact(artifact: Artifact): Promise<ArtifactOutcome> { return this.service.artifact(artifact); }
}
