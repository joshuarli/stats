import { parseProjects, type ProjectConfig } from "./config.ts";
import { runProbes, type ProbeFetch } from "./probes.ts";
import {
  parseD1Rows,
  parseD1StatementRows,
  parseD1StorageRows,
  parseDurableObjectRows,
  parseR2OperationRows,
  parseR2StorageRows,
  parseRouteRows,
  parseWorkerRows,
  type MetricPoint,
} from "./parse.ts";
import { BUCKET_MS, d1Query, d1StatementQuery, d1StorageQuery, durableObjectQuery, r2OperationsQuery, r2StorageQuery, routeQuery, workerQuery, type BoundQuery } from "./queries.ts";
import type { CollectorRun, ProjectPoints } from "./store.ts";
import { reportError } from "../observe/producer/report.ts";

const COLLECTION_WINDOW_MS = 90 * 60_000;

export interface AnalyticsQuery {
  query(request: BoundQuery): Promise<{
    readonly data: readonly unknown[];
    readonly statistics: { readonly rows_read: number };
  }>;
}

interface CollectorStore {
  recordCollectorRun(run: CollectorRun): Promise<{ metricRowsWritten: number }>;
}

interface CollectorInput {
  readonly analytics: AnalyticsQuery;
  readonly store: CollectorStore;
  readonly projectsJson: string;
  readonly storeWorker: string;
  readonly now: number;
  readonly probeFetch: ProbeFetch;
}

interface CollectorResult {
  readonly queries: number;
  readonly metricRowsWritten: number;
}

export function windowStartMs(now: number): number {
  return Math.floor((now - COLLECTION_WINDOW_MS) / BUCKET_MS) * BUCKET_MS;
}

export async function runCollector(input: CollectorInput): Promise<CollectorResult> {
  const startedAt = Date.now();
  const elapsed = () => Math.max(0, Date.now() - startedAt);
  let queries = 0;
  let rowsRead = 0;
  try {
    const projects = parseProjects(input.projectsJson);
    const startMs = windowStartMs(input.now);
    const run = async (bound: BoundQuery): Promise<readonly unknown[]> => {
      queries += 1;
      const result = await input.analytics.query(bound);
      rowsRead += result.statistics.rows_read;
      return result.data;
    };
    const collected = await Promise.all(projects.map((project) => collectProject(project, startMs, run, input.probeFetch, input.now)));
    const { metricRowsWritten } = await input.store.recordCollectorRun({
      ok: true,
      atMs: input.now + elapsed(),
      detail: "ok",
      rowsRead,
      durationMs: elapsed(),
      collected,
      storeOwners: projects.filter((project) => project.worker === input.storeWorker).map((project) => project.id),
    });
    return { queries, metricRowsWritten };
  } catch (error) {
    console.error(JSON.stringify({ event: "collector_failed" }));
    try {
      await input.store.recordCollectorRun({
        ok: false,
        atMs: input.now + elapsed(),
        detail: "collector_failed",
        rowsRead,
        durationMs: elapsed(),
      });
    } catch (recordError) {
      reportError("collector.record", recordError);
      console.error(JSON.stringify({ event: "collector_run_unrecorded" }));
    }
    throw error;
  }
}

async function collectProject(
  project: ProjectConfig,
  startMs: number,
  run: (bound: BoundQuery) => Promise<readonly unknown[]>,
  probeFetch: ProbeFetch,
  now: number,
): Promise<ProjectPoints> {
  const hasBuckets = project.buckets.length > 0;
  const hasNamespaces = project.durableObjectNamespaces.length > 0;
  const hasDatabases = project.d1Databases.length > 0;
  const [worker, routes, durableObjects, operations, storage, d1, d1Statements, d1Storage, probes] = await Promise.all([
    run(workerQuery(project.worker, startMs)),
    run(routeQuery(project.worker, startMs)),
    hasNamespaces ? run(durableObjectQuery(project.durableObjectNamespaces, startMs)) : [],
    hasBuckets ? run(r2OperationsQuery(project.buckets, startMs)) : [],
    hasBuckets ? run(r2StorageQuery(project.buckets, startMs)) : [],
    hasDatabases ? run(d1Query(project.d1Databases, startMs)) : [],
    hasDatabases ? run(d1StatementQuery(project.d1Databases, startMs)) : [],
    hasDatabases ? run(d1StorageQuery(project.d1Databases, startMs)) : [],
    runProbes({ fetch: probeFetch, probes: project.probes, now }),
  ]);
  const points: MetricPoint[] = [
    ...parseWorkerRows(worker),
    ...parseRouteRows(routes),
    ...parseDurableObjectRows(durableObjects),
    ...parseR2OperationRows(operations),
    ...parseR2StorageRows(storage),
    ...parseD1Rows(d1),
    ...parseD1StatementRows(d1Statements),
    ...parseD1StorageRows(d1Storage),
    ...probes,
  ];
  return { project: project.id, points };
}
