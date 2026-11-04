import { prepareRollout, prepareVersionLabel, type ObservedRollout, type Preparation, type VersionLabel } from "./model.ts";
import {
  cleanup, explore, health, ingest, issueOccurrences, listIssues, listTraces, nextCleanupAt, readIssue, readTrace, recordRollouts, rolloutImpact, setIssueState,
  type CleanupResult, type Exploration, type Health, type IngestResult, type IssueState, type IssueSummary, type Occurrence, type Page, type RolloutImpact,
  type RolloutResult, type SqlDatabase, type TraceDetail, type TraceFilter, type TraceSummary
} from "./store.ts";

export interface ServiceHealth extends Health {
  readonly databaseBytes: number;
}

export interface ObserveService {
  issues(filter: { readonly state?: IssueState; readonly introducedIn?: string; readonly cursor?: string; readonly limit?: number }): Promise<Page<IssueSummary>>;
  issue(fingerprint: string): Promise<IssueSummary | null>;
  occurrences(fingerprint: string, filter: { readonly cursor?: string; readonly limit?: number }): Promise<Page<Occurrence>>;
  setIssueState(fingerprint: string, state: IssueState): Promise<boolean>;
  traces(filter: TraceFilter): Promise<Page<TraceSummary>>;
  trace(traceId: string): Promise<TraceDetail | null>;
  health(): Promise<ServiceHealth>;
  rollouts(rollouts: readonly ObservedRollout[], labels: readonly VersionLabel[]): Promise<RolloutResult>;
  impact(rolloutId: string): Promise<RolloutImpact | null>;
  explore(filter: { readonly fromMs?: number; readonly toMs?: number; readonly route?: string }): Promise<Exploration>;
}

export interface MaintainedService extends ObserveService {
  ingest(preparations: readonly Preparation[]): IngestResult;
  cleanup(): { readonly cleaned: CleanupResult; readonly nextAtMs: number | null };
}

export interface ServiceClock {
  readonly now: () => number;
  readonly databaseBytes: () => number;
}

export function createObserveService(db: SqlDatabase, clock: ServiceClock): MaintainedService {
  return {
    issues: async filter => listIssues(db, clock.now(), filter),
    issue: async fingerprint => readIssue(db, clock.now(), fingerprint),
    occurrences: async (fingerprint, filter) => issueOccurrences(db, clock.now(), fingerprint, filter),
    setIssueState: async (fingerprint, state) => setIssueState(db, clock.now(), fingerprint, state),
    traces: async filter => listTraces(db, clock.now(), filter),
    trace: async traceId => readTrace(db, clock.now(), traceId),
    health: async () => ({ ...health(db, clock.now()), databaseBytes: clock.databaseBytes() }),
    rollouts: async (rollouts, labels) => {
      const prepared = await Promise.all(rollouts.map(prepareRollout));
      return recordRollouts(db, prepared, labels.flatMap(label => prepareVersionLabel(label) ?? []), clock.now());
    },
    impact: async rolloutId => rolloutImpact(db, clock.now(), rolloutId),
    explore: async filter => explore(db, clock.now(), filter),
    ingest: preparations => ingest(db, preparations, clock.now()),
    cleanup: () => {
      const now = clock.now();
      const cleaned = cleanup(db, now);
      return { cleaned, nextAtMs: nextCleanupAt(db, now, cleaned) };
    }
  };
}
