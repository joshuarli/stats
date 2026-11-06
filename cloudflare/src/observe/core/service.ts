import { artifactProblem, prepareRollout, prepareVersionLabel, type Artifact, type ObservedRollout, type OutcomeEvent, type Preparation, type Stage, type VersionLabel } from "./model.ts";
import { observedByRoute, samplingSummary } from "./counts.ts";
import type { Sampling } from "./sampling.ts";
import { representativeFrame, sha256Hex } from "./grouping.ts";
import { RETENTION_MS } from "./limits.ts";
import { createSymbolicator } from "./symbolicate.ts";
import {
  cleanup, eventWindow, explore, health, objectMethods, ingest, issueOccurrences, latestFrames, listIssues, listTraces, nextCleanupAt, readArtifact, readIssue, readTrace, recordArtifact, recordRollouts, rolloutImpact, setIssueState, statsWindow,
  KEEP_ALL_COUNTING, type ArtifactResult, type CleanupResult, type CountingPolicy, type Exploration, type Health, type IngestResult, type ObjectMethods, type IssueState, type IssueSummary, type Occurrence, type Page, type RolloutImpact,
  type RolloutResult, type RouteStats, type StatsWindow, type TraceDetail, type TraceFilter, type TracePage, type WindowQuery
} from "./store.ts";
import type { SqlStatements } from "../../core/sql.ts";

export interface ServiceHealth extends Health {
  readonly databaseBytes: number;
}

export interface ObserveService {
  issues(filter: { readonly state?: IssueState; readonly introducedIn?: string; readonly cursor?: string; readonly limit?: number }): Promise<Page<IssueSummary>>;
  issue(fingerprint: string): Promise<IssueSummary | null>;
  occurrences(fingerprint: string, filter: { readonly cursor?: string; readonly limit?: number }): Promise<Page<Occurrence>>;
  setIssueState(fingerprint: string, state: IssueState): Promise<boolean>;
  traces(filter: TraceFilter): Promise<TracePage>;
  trace(traceId: string): Promise<TraceDetail | null>;
  health(): Promise<ServiceHealth>;
  rollouts(rollouts: readonly ObservedRollout[], labels: readonly VersionLabel[]): Promise<RolloutResult>;
  impact(rolloutId: string): Promise<RolloutImpact | null>;
  explore(filter: { readonly fromMs?: number; readonly toMs?: number; readonly route?: string }): Promise<Exploration>;
  objects(filter: { readonly fromMs?: number; readonly toMs?: number }): Promise<ObjectMethods>;
  window(query: WindowQuery): Promise<StatsWindow>;
  artifact(artifact: Artifact): Promise<ArtifactOutcome>;
}

export type ArtifactOutcome = { readonly result: ArtifactResult } | { readonly problem: string };

export interface MaintainedService extends ObserveService {
  ingest(preparations: readonly Preparation[], outcomes: readonly OutcomeEvent[], counts: readonly unknown[]): IngestResult;
  cleanup(): { readonly cleaned: CleanupResult; readonly nextAtMs: number | null };
}

export interface ServiceClock {
  readonly now: () => number;
  readonly databaseBytes: () => number;
}

export function createObserveService(db: SqlStatements, clock: ServiceClock, policy: () => CountingPolicy = () => KEEP_ALL_COUNTING): MaintainedService {
  const sampling = (): Sampling => policy().sampling;
  const symbolicate = createSymbolicator((version, file) => readArtifact(db, version, file));
  const withSources = <T extends Occurrence>(occurrence: T): T => ({ ...occurrence, frames: symbolicate(occurrence.frames, occurrence.version) });
  const withFrame = <T extends { readonly fingerprint: string; readonly frame: string | null }>(issue: T): T => {
    const latest = latestFrames(db, clock.now(), issue.fingerprint);
    if (latest === null) return issue;
    const shown = symbolicate(latest.frames, latest.version).map(frame => frame.original ?? frame);
    return { ...issue, frame: representativeFrame(shown) ?? issue.frame };
  };
  const summarized = <T extends object>(result: T, fromMs: number, toMs: number, stage: Stage | null): T => {
    const policy = sampling();
    return policy.kind === "sampled" ? { ...result, sampling: samplingSummary(db, policy, fromMs, toMs, stage) } : result;
  };
  const retained = () => ({ fromMs: clock.now() - RETENTION_MS, toMs: clock.now() });
  return {
    issues: async filter => {
      const page = listIssues(db, clock.now(), filter);
      return { ...page, items: page.items.map(withFrame) };
    },
    issue: async fingerprint => {
      const issue = readIssue(db, clock.now(), fingerprint);
      return issue === null ? null : withFrame(issue);
    },
    occurrences: async (fingerprint, filter) => {
      const page = issueOccurrences(db, clock.now(), fingerprint, filter);
      return { ...page, items: page.items.map(withSources) };
    },
    setIssueState: async (fingerprint, state) => setIssueState(db, clock.now(), fingerprint, state),
    traces: async filter => {
      const page = listTraces(db, clock.now(), filter);
      const { fromMs, toMs } = eventWindow(clock.now(), filter.fromMs, filter.toMs);
      return summarized(page, fromMs, toMs, "worker");
    },
    trace: async traceId => {
      const detail = readTrace(db, clock.now(), traceId);
      if (detail === null) return null;
      const { fromMs, toMs } = retained();
      return summarized({ ...detail, occurrences: detail.occurrences.map(withSources) }, fromMs, toMs, null);
    },
    health: async () => ({ ...health(db, clock.now(), sampling()), databaseBytes: clock.databaseBytes() }),
    rollouts: async (rollouts, labels) => {
      const prepared = await Promise.all(rollouts.map(prepareRollout));
      return recordRollouts(db, prepared, labels.flatMap(label => prepareVersionLabel(label) ?? []), clock.now());
    },
    impact: async rolloutId => {
      const impact = rolloutImpact(db, clock.now(), rolloutId, sampling());
      if (impact === null) return null;
      const { fromMs, toMs } = retained();
      return summarized({ ...impact, newIssues: impact.newIssues.map(withFrame), regressions: impact.regressions.map(withFrame) }, fromMs, toMs, "worker");
    },
    explore: async filter => {
      const exploration = explore(db, clock.now(), filter);
      const policy = sampling();
      if (policy.kind === "all") return exploration;
      const observed = observedByRoute(db, exploration.fromMs, exploration.toMs, "worker");
      const kept = exploration.routes.map((route): RouteStats => ({ ...route, observed: observed.get(route.label) ?? 0 }));
      const sampledOut = [...observed].filter(([label]) => !exploration.routes.some(route => route.label === label)).map(([label, count]): RouteStats => ({
        label, requests: 0, failed: 0, cpuMs: 0, p50WallMs: null, p95WallMs: null, p99WallMs: null, p50CpuMs: null, p95CpuMs: null, observed: count, unmeasured: "sampled-out"
      }));
      const routes = [...kept, ...sampledOut].sort((a, b) => b.cpuMs - a.cpuMs || a.label.localeCompare(b.label));
      return summarized({ ...exploration, routes }, exploration.fromMs, exploration.toMs, "worker");
    },
    objects: async filter => {
      const methods = objectMethods(db, clock.now(), filter);
      return summarized(methods, methods.fromMs, methods.toMs, "object");
    },
    window: async query => {
      const window = statsWindow(db, query, sampling());
      return summarized(window, window.fromMs, window.toMs, null);
    },
    artifact: async artifact => {
      const problem = artifactProblem(artifact);
      if (problem !== null) return { problem };
      return { result: recordArtifact(db, { ...artifact, digest: await sha256Hex(artifact.map) }, clock.now()) };
    },
    ingest: (preparations, outcomes, counts) => ingest(db, preparations, clock.now(), outcomes, { ...policy(), counts }),
    cleanup: () => {
      const now = clock.now();
      const cleaned = cleanup(db, now);
      return { cleaned, nextAtMs: nextCleanupAt(db, now, cleaned) };
    }
  };
}
