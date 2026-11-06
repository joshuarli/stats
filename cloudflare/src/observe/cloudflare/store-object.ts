import { DurableObject } from "cloudflare:workers";
import type { Artifact, CountDelta, ObservedRollout, OutcomeEvent, Preparation, VersionLabel } from "../core/model.ts";
import { initializeStore, type Exploration, type IngestResult, type ObjectMethods, type IssueState, type IssueSummary, type Occurrence, type Page, type RolloutImpact, type RolloutResult, type StatsWindow, type TraceDetail, type TraceFilter, type TracePage, type WindowQuery } from "../core/store.ts";
import { createObserveService, type ArtifactOutcome, type MaintainedService, type ObserveService, type ServiceHealth } from "../core/service.ts";
import { CLEANUP_INTERVAL_MS } from "../core/limits.ts";
import type { Sampling } from "../core/sampling.ts";
import { isObservedService } from "../services.ts";
import { POLICIES } from "../core/policies.ts";
import { CloudflareSql } from "../../cloudflare/sql.ts";

export interface ObserveEnv {
  readonly STORE: DurableObjectNamespace<ObservationStore>;
}

function samplingOf(name: string | undefined): Sampling {
  if (name === undefined || !isObservedService(name)) throw new Error(`observation store has no observed service name: ${name ?? "unnamed"}`);
  return POLICIES[name].sampling;
}

export class ObservationStore extends DurableObject<ObserveEnv> implements ObserveService {
  private readonly service: MaintainedService;

  constructor(ctx: DurableObjectState, env: ObserveEnv) {
    super(ctx, env);
    const db = new CloudflareSql(ctx.storage);
    this.service = createObserveService(db, { now: () => Date.now(), databaseBytes: () => db.databaseBytes() }, () => samplingOf(ctx.id.name));
    void ctx.blockConcurrencyWhile(async () => { initializeStore(db); });
  }

  async ingest(preparations: readonly Preparation[], outcomes: readonly OutcomeEvent[], counts: readonly CountDelta[]): Promise<IngestResult> {
    const result = this.service.ingest(preparations, outcomes, counts);
    if ((result.accepted > 0 || counts.length > 0) && await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + CLEANUP_INTERVAL_MS);
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
  async objects(filter: { readonly fromMs?: number; readonly toMs?: number }): Promise<ObjectMethods> { return this.service.objects(filter); }
  async window(query: WindowQuery): Promise<StatsWindow> { return this.service.window(query); }
  async traces(filter: TraceFilter): Promise<TracePage> { return this.service.traces(filter); }
  async trace(traceId: string): Promise<TraceDetail | null> { return this.service.trace(traceId); }
  async health(): Promise<ServiceHealth> { return this.service.health(); }
  async artifact(artifact: Artifact): Promise<ArtifactOutcome> { return this.service.artifact(artifact); }
}
