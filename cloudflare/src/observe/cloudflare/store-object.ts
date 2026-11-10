import { DurableObject } from "cloudflare:workers";
import type { Artifact, ObservedRollout, OutcomeEvent, Preparation, VersionLabel } from "../core/model.ts";
import type { ExternalEvent, ExternalEventRecord, ExternalFilter, ExternalIngest } from "../ingest/model.ts";
import { initializeStore, KEEP_ALL_COUNTING, type CountingPolicy, type Exploration, type IngestResult, type ObjectMethods, type IssueState, type IssueSummary, type Occurrence, type Page, type RolloutImpact, type RolloutResult, type StatsWindow, type TraceDetail, type TraceFilter, type TracePage, type WindowQuery, type ExternalOperationsWindow } from "../core/store.ts";
import type { ProfileWindow } from "../core/profile.ts";
import { createObserveService, type ArtifactOutcome, type MaintainedService, type ObserveService, type ServiceHealth } from "../core/service.ts";
import { CLEANUP_INTERVAL_MS } from "../core/limits.ts";
import { POLICIES } from "../core/policies.ts";
import { CloudflareSql } from "../../cloudflare/sql.ts";

export interface ObserveEnv {
  readonly STORE: DurableObjectNamespace<ObservationStore>;
  readonly TEST_IDLE_FLUSH_MS?: string;
  readonly OBSERVE_LOCAL_SERVICES?: string;
}

function policyOf(name: string | undefined): CountingPolicy {
  if (name === undefined) throw new Error("observation store has no service name");
  return (POLICIES as Readonly<Record<string, CountingPolicy>>)[name] ?? KEEP_ALL_COUNTING;
}

export class ObservationStore extends DurableObject<ObserveEnv> implements ObserveService {
  private readonly service: MaintainedService;

  constructor(ctx: DurableObjectState, env: ObserveEnv) {
    super(ctx, env);
    const db = new CloudflareSql(ctx.storage);
    this.service = createObserveService(db, { now: () => Date.now(), databaseBytes: () => db.databaseBytes() }, () => policyOf(ctx.id.name));
    void ctx.blockConcurrencyWhile(async () => { initializeStore(db); });
  }

  async ingest(preparations: readonly Preparation[], outcomes: readonly OutcomeEvent[], counts: readonly unknown[], flush?: unknown, captureOperations = false): Promise<IngestResult> {
    const result = this.service.ingest(preparations, outcomes, counts, flush, captureOperations);
    if ((result.accepted > 0 || counts.length > 0 || (flush ?? null) !== null) && await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + CLEANUP_INTERVAL_MS);
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
  async profile(filter: { readonly fromMs?: number; readonly toMs?: number }): Promise<ProfileWindow> { return this.service.profile(filter); }
  async traces(filter: TraceFilter): Promise<TracePage> { return this.service.traces(filter); }
  async trace(traceId: string): Promise<TraceDetail | null> { return this.service.trace(traceId); }
  async health(): Promise<ServiceHealth> { return this.service.health(); }
  async artifact(artifact: Artifact): Promise<ArtifactOutcome> { return this.service.artifact(artifact); }
  async ingestExternal(service: string, events: readonly ExternalEvent[]): Promise<ExternalIngest> {
    const result = await this.service.ingestExternal(service, events);
    if (result.ok && result.accepted > 0 && await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + CLEANUP_INTERVAL_MS);
    return result;
  }
  async external(service: string, filter: ExternalFilter): Promise<readonly ExternalEventRecord[]> { return this.service.external(service, filter); }
  async externalOperations(service: string, filter: Pick<ExternalFilter, "fromMs" | "toMs">): Promise<ExternalOperationsWindow> { return this.service.externalOperations(service, filter); }
}
