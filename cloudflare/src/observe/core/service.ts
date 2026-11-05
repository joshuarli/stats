import { artifactProblem, prepareRollout, prepareVersionLabel, type Artifact, type ObservedRollout, type Preparation, type VersionLabel } from "./model.ts";
import { representativeFrame, sha256Hex } from "./grouping.ts";
import { createSymbolicator } from "./symbolicate.ts";
import {
  cleanup, explore, health, objectMethods, ingest, issueOccurrences, latestFrames, listIssues, listTraces, nextCleanupAt, readArtifact, readIssue, readTrace, recordArtifact, recordRollouts, rolloutImpact, setIssueState,
  type ArtifactResult, type CleanupResult, type Exploration, type Health, type IngestResult, type ObjectMethods, type IssueState, type IssueSummary, type Occurrence, type Page, type RolloutImpact,
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
  objects(filter: { readonly fromMs?: number; readonly toMs?: number }): Promise<ObjectMethods>;
  artifact(artifact: Artifact): Promise<ArtifactOutcome>;
}

export type ArtifactOutcome = { readonly result: ArtifactResult } | { readonly problem: string };

export interface MaintainedService extends ObserveService {
  ingest(preparations: readonly Preparation[]): IngestResult;
  cleanup(): { readonly cleaned: CleanupResult; readonly nextAtMs: number | null };
}

export interface ServiceClock {
  readonly now: () => number;
  readonly databaseBytes: () => number;
}

export function createObserveService(db: SqlDatabase, clock: ServiceClock): MaintainedService {
  const symbolicate = createSymbolicator((version, file) => readArtifact(db, version, file));
  const withSources = <T extends Occurrence>(occurrence: T): T => ({ ...occurrence, frames: symbolicate(occurrence.frames, occurrence.version) });
  const withFrame = <T extends { readonly fingerprint: string; readonly frame: string | null }>(issue: T): T => {
    const latest = latestFrames(db, clock.now(), issue.fingerprint);
    if (latest === null) return issue;
    const shown = symbolicate(latest.frames, latest.version).map(frame => frame.original ?? frame);
    return { ...issue, frame: representativeFrame(shown) ?? issue.frame };
  };
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
    traces: async filter => listTraces(db, clock.now(), filter),
    trace: async traceId => {
      const detail = readTrace(db, clock.now(), traceId);
      return detail === null ? null : { ...detail, occurrences: detail.occurrences.map(withSources) };
    },
    health: async () => ({ ...health(db, clock.now()), databaseBytes: clock.databaseBytes() }),
    rollouts: async (rollouts, labels) => {
      const prepared = await Promise.all(rollouts.map(prepareRollout));
      return recordRollouts(db, prepared, labels.flatMap(label => prepareVersionLabel(label) ?? []), clock.now());
    },
    impact: async rolloutId => {
      const impact = rolloutImpact(db, clock.now(), rolloutId);
      return impact === null ? null : { ...impact, newIssues: impact.newIssues.map(withFrame), regressions: impact.regressions.map(withFrame) };
    },
    explore: async filter => explore(db, clock.now(), filter),
    objects: async filter => objectMethods(db, clock.now(), filter),
    artifact: async artifact => {
      const problem = artifactProblem(artifact);
      if (problem !== null) return { problem };
      return { result: recordArtifact(db, { ...artifact, digest: await sha256Hex(artifact.map) }, clock.now()) };
    },
    ingest: preparations => ingest(db, preparations, clock.now()),
    cleanup: () => {
      const now = clock.now();
      const cleaned = cleanup(db, now);
      return { cleaned, nextAtMs: nextCleanupAt(db, now, cleaned) };
    }
  };
}
