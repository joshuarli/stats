import { parseProjects, type ProjectConfig } from "../../projects/config.ts";
import { runProbes, type ProbeFetch } from "../../projects/probes.ts";
import {
  parseD1Rows,
  parseD1StatementRows,
  parseD1StorageRows,
  parseDurableObjectRows,
  parseR2OperationRows,
  parseR2StorageRows,
  parseRouteRows,
  parseWorkerRows,
} from "./parse.ts";
import { windowStartMs, type MetricPoint } from "../../projects/metrics.ts";
import { d1Query, d1StatementQuery, d1StorageQuery, durableObjectQuery, r2OperationsQuery, r2StorageQuery, routeQuery, workerQuery, type BoundQuery } from "../../projects/queries.ts";
import type { CollectorRun, ProjectPoints } from "../../projects/store.ts";
import { reportError } from "../../observe/producer/report.ts";

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

function errorStatus(error: unknown): number | string | null {
  if (typeof error === "object" && error !== null) {
    if ("status" in error && (typeof error.status === "number" || typeof error.status === "string")) return error.status;
    if ("statusCode" in error && (typeof error.statusCode === "number" || typeof error.statusCode === "string")) return error.statusCode;
    if ("code" in error && (typeof error.code === "number" || typeof error.code === "string")) return error.code;
  }
  return null;
}

export async function runCollector(input: CollectorInput): Promise<CollectorResult> {
  const startedAt = Date.now();
  const elapsed = () => Math.max(0, Date.now() - startedAt);
  let queries = 0;
  let rowsRead = 0;
  const failure: { current: { kind: string; status: number | string | null } | null } = { current: null };
  try {
    const projects = parseProjects(input.projectsJson);
    const startMs = windowStartMs(input.now);
    const run = async (kind: string, bound: BoundQuery): Promise<readonly unknown[]> => {
      queries += 1;
      try {
        const result = await input.analytics.query(bound);
        rowsRead += result.statistics.rows_read;
        return result.data;
      } catch (error) {
        const status = errorStatus(error);
        if (status === 429 || (typeof status === "number" && status >= 500 && status < 600)) {
          queries += 1;
          try {
            const retried = await input.analytics.query(bound);
            rowsRead += retried.statistics.rows_read;
            return retried.data;
          } catch (retryError) {
            failure.current ??= { kind, status: errorStatus(retryError) ?? status };
            throw retryError;
          }
        }
        failure.current ??= { kind, status };
        throw error;
      }
    };
    const collected = await Promise.all(projects.map((project) => collectProject(project, startMs, run, input.probeFetch, input.now)));
    const { metricRowsWritten } = await input.store.recordCollectorRun({
      ok: true,
      atMs: input.now + elapsed(),
      detail: "ok",
      rowsRead,
      durationMs: elapsed(),
      upstreamQueries: queries,
      collected,
      storeOwners: projects.filter((project) => project.worker === input.storeWorker).map((project) => project.id),
    });
    return { queries, metricRowsWritten };
  } catch (error) {
    const status = failure.current?.status ?? errorStatus(error);
    const query = failure.current?.kind ?? null;
    const detail = query !== null
      ? (status !== null ? `collector_failed:${query}:${status}` : `collector_failed:${query}`)
      : "collector_failed";
    console.error(JSON.stringify({ event: "collector_failed", ...(query !== null ? { query } : {}), ...(status !== null ? { status } : {}) }));
    try {
      await input.store.recordCollectorRun({
        ok: false,
        atMs: input.now + elapsed(),
        detail,
        rowsRead,
        durationMs: elapsed(),
        upstreamQueries: queries,
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
  run: (kind: string, bound: BoundQuery) => Promise<readonly unknown[]>,
  probeFetch: ProbeFetch,
  now: number,
): Promise<ProjectPoints> {
  const hasBuckets = project.buckets.length > 0;
  const hasNamespaces = project.durableObjectNamespaces.length > 0;
  const hasDatabases = project.d1Databases.length > 0;
  const [worker, routes, durableObjects, operations, storage, d1, d1Statements, d1Storage, probes] = await Promise.all([
    run("worker", workerQuery(project.worker, startMs)),
    run("routes", routeQuery(project.worker, startMs)),
    hasNamespaces ? run("durableObjects", durableObjectQuery(project.durableObjectNamespaces, startMs)) : [],
    hasBuckets ? run("r2Operations", r2OperationsQuery(project.buckets, startMs)) : [],
    hasBuckets ? run("r2Storage", r2StorageQuery(project.buckets, startMs)) : [],
    hasDatabases ? run("d1", d1Query(project.d1Databases, startMs)) : [],
    hasDatabases ? run("d1Statements", d1StatementQuery(project.d1Databases, startMs)) : [],
    hasDatabases ? run("d1Storage", d1StorageQuery(project.d1Databases, startMs)) : [],
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
