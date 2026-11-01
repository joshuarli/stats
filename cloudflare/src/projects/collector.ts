import { parseProjects, type ProjectConfig } from "./config.ts";
import { runProbes, type ProbeFetch } from "./probes.ts";
import {
  parseR2OperationRows,
  parseR2StorageRows,
  parseWorkerRows,
  type MetricPoint,
} from "./parse.ts";
import { BUCKET_MS, r2OperationsQuery, r2StorageQuery, workerQuery, type BoundQuery } from "./queries.ts";
import type { CollectorRun, ProjectPoints } from "./store.ts";

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
  let collected: ProjectPoints[];
  try {
    const projects = parseProjects(input.projectsJson);
    const startMs = windowStartMs(input.now);
    const run = async (bound: BoundQuery): Promise<readonly unknown[]> => {
      queries += 1;
      const result = await input.analytics.query(bound);
      rowsRead += result.statistics.rows_read;
      return result.data;
    };
    collected = await Promise.all(projects.map((project) => collectProject(project, startMs, run, input.probeFetch, input.now)));
  } catch (error) {
    console.error(JSON.stringify({ event: "collector_failed" }));
    await input.store.recordCollectorRun({
      ok: false,
      atMs: input.now + elapsed(),
      detail: "collector_failed",
      rowsRead,
      durationMs: elapsed(),
    });
    throw error;
  }
  const { metricRowsWritten } = await input.store.recordCollectorRun({
    ok: true,
    atMs: input.now + elapsed(),
    detail: "ok",
    rowsRead,
    durationMs: elapsed(),
    collected,
  });
  return { queries, metricRowsWritten };
}

async function collectProject(
  project: ProjectConfig,
  startMs: number,
  run: (bound: BoundQuery) => Promise<readonly unknown[]>,
  probeFetch: ProbeFetch,
  now: number,
): Promise<ProjectPoints> {
  const [worker, operations, storage, probes] = await Promise.all([
    run(workerQuery(project.worker, startMs)),
    run(r2OperationsQuery(project.buckets, startMs)),
    run(r2StorageQuery(project.buckets, startMs)),
    runProbes({ fetch: probeFetch, probes: project.probes, now }),
  ]);
  const points: MetricPoint[] = [
    ...parseWorkerRows(worker),
    ...parseR2OperationRows(operations),
    ...parseR2StorageRows(storage),
    ...probes,
  ];
  return { project: project.id, points };
}
