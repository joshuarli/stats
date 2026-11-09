import { parseProjects, type ProjectConfig } from "../src/projects/config.ts";
import { windowStartMs } from "../src/projects/metrics.ts";
import { BUCKET_MS, d1Query, d1StatementQuery, d1StorageQuery, durableObjectQuery, r2OperationsQuery, r2StorageQuery, routeQuery, workerQuery, type BoundQuery } from "../src/projects/queries.ts";

export const DATASETS = ["logs.workersLogs", "events.durableObjectsInvocations", "events.r2CombinedOperations", "states.r2CombinedStorage", "events.d1Queries", "states.d1Storage"] as const;
export type Dataset = (typeof DATASETS)[number];

export const QUERY_KINDS = ["worker", "route", "durableObjects", "r2Operations", "r2Storage", "d1", "d1Statements", "d1Storage"] as const;
export type QueryKind = (typeof QUERY_KINDS)[number];

export const DATASET_OF: Readonly<Record<QueryKind, Dataset>> = {
  worker: "logs.workersLogs",
  route: "logs.workersLogs",
  durableObjects: "events.durableObjectsInvocations",
  r2Operations: "events.r2CombinedOperations",
  r2Storage: "states.r2CombinedStorage",
  d1: "events.d1Queries",
  d1Statements: "events.d1Queries",
  d1Storage: "states.d1Storage"
};

export type Mode =
  | { readonly kind: "ok" }
  | { readonly kind: "empty" }
  | { readonly kind: "late"; readonly omitNewestSlots: number }
  | { readonly kind: "fail" };

export interface Raise {
  readonly project: string;
  readonly slotMs: number;
  readonly by: number;
}

export interface Scenario {
  readonly projectsJson: string;
  readonly nowMs: number;
  readonly modes: Readonly<Record<Dataset, Mode>>;
  readonly raise: Raise | null;
}

export const RECORDED_AT_MS = Date.UTC(2026, 10, 1, 16, 35);
const STORAGE_BUCKET_MS = 2 * BUCKET_MS;

function allModes(mode: Mode): Readonly<Record<Dataset, Mode>> {
  return Object.fromEntries(DATASETS.map(dataset => [dataset, mode])) as Record<Dataset, Mode>;
}

export function scenario(projectsJson: string, nowMs: number, modes: Partial<Record<Dataset, Mode>> = {}, raise: Raise | null = null): Scenario {
  return { projectsJson, nowMs, modes: { ...allModes({ kind: "ok" }), ...modes }, raise };
}

export interface ExpectedQuery {
  readonly kind: QueryKind;
  readonly project: string;
  readonly bound: BoundQuery;
}

export function expectedQueries(model: Scenario): ExpectedQuery[] {
  const startMs = windowStartMs(model.nowMs);
  return parseProjects(model.projectsJson).flatMap(project => {
    const queries: [QueryKind, BoundQuery][] = [["worker", workerQuery(project.worker, startMs)], ["route", routeQuery(project.worker, startMs)]];
    if (project.durableObjectNamespaces.length > 0) queries.push(["durableObjects", durableObjectQuery(project.durableObjectNamespaces, startMs)]);
    if (project.buckets.length > 0) queries.push(["r2Operations", r2OperationsQuery(project.buckets, startMs)], ["r2Storage", r2StorageQuery(project.buckets, startMs)]);
    if (project.d1Databases.length > 0) queries.push(["d1", d1Query(project.d1Databases, startMs)], ["d1Statements", d1StatementQuery(project.d1Databases, startMs)], ["d1Storage", d1StorageQuery(project.d1Databases, startMs)]);
    return queries.map(([kind, bound]) => ({ kind, project: project.id, bound }));
  });
}

export function queryKey(bound: BoundQuery): string {
  return JSON.stringify([bound.query, Object.entries(bound.params).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)]);
}

export function slots(model: Scenario, dataset: Dataset): number[] {
  const mode = model.modes[dataset];
  if (mode.kind === "empty" || mode.kind === "fail") return [];
  const cutoff = model.nowMs - (mode.kind === "late" ? mode.omitNewestSlots * BUCKET_MS : 0);
  const step = dataset.startsWith("states.") ? STORAGE_BUCKET_MS : BUCKET_MS;
  const first = Math.ceil(windowStartMs(model.nowMs) / step) * step;
  const result: number[] = [];
  for (let slotMs = first; slotMs + BUCKET_MS <= cutoff; slotMs += step) result.push(slotMs);
  return result;
}

function seed(text: string): number {
  let value = 0;
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) % 9973;
  return value;
}

function phase(slotMs: number): number {
  return Math.floor(slotMs / BUCKET_MS) % 7;
}

export const WORKER_STATUSES = [200, 404] as const;
const ROUTE_LABELS = ["GET /api/v1/items", "POST /api/v1/items"] as const;
export const R2_ACTIONS = ["success", "userError"] as const;
export const D1_STATEMENTS = ["SELECT * FROM items WHERE id = ?", "INSERT INTO items (id, body) VALUES (?, ?)"] as const;

export const values = {
  workerInvocations(model: Scenario, project: string, slotMs: number, status: number): number {
    const raised = model.raise !== null && model.raise.project === project && model.raise.slotMs === slotMs && status === WORKER_STATUSES[0] ? model.raise.by : 0;
    return 10 + phase(slotMs) + (seed(project) % 5) + (status === WORKER_STATUSES[0] ? 20 : 0) + raised;
  },
  workerCpuMs(invocations: number): number {
    return invocations * 3;
  },
  workerCpuMaxMs(slotMs: number): number {
    return 4 + phase(slotMs);
  },
  routeInvocations(project: string, slotMs: number, label: number): number {
    return 5 + phase(slotMs) + (seed(project) % 3) + label * 4;
  },
  durableObjectInvocations(project: string, slotMs: number): number {
    return 8 + phase(slotMs) + (seed(project) % 4);
  },
  r2Operations(bucket: string, slotMs: number, action: number): number {
    return action === 0 ? 30 + phase(slotMs) + (seed(bucket) % 6) : 1 + (phase(slotMs) % 2);
  },
  r2StorageBytes(bucket: string, slotMs: number): number {
    return 100_000_000 + seed(bucket) * 1000 + phase(slotMs) * 10;
  },
  r2Objects(bucket: string, slotMs: number): number {
    return 1000 + seed(bucket) + phase(slotMs);
  },
  d1Queries(project: string, slotMs: number, statement: number): number {
    return 12 + phase(slotMs) + (seed(project) % 3) + statement * 2;
  },
  d1RowsRead(queries: number): number {
    return queries * 25;
  },
  d1RowsWritten(queries: number, statement: number): number {
    return statement === 1 ? queries : 0;
  },
  d1SizeBytes(database: string, slotMs: number): number {
    return 4_000_000 + seed(database) * 10 + phase(slotMs);
  }
};

function workerTime(slotMs: number): { day: string; hour: number; slot: number } {
  const date = new Date(slotMs);
  return { day: date.toISOString().slice(0, 10), hour: date.getUTCHours(), slot: Math.floor(date.getUTCMinutes() / 5) };
}

function datetime(slotMs: number): string {
  return new Date(slotMs).toISOString().slice(0, 19).replace("T", " ");
}

function project(model: Scenario, id: string): ProjectConfig {
  const found = parseProjects(model.projectsJson).find(candidate => candidate.id === id);
  if (found === undefined) throw new RangeError(`scenario has no project ${id}`);
  return found;
}

export function rows(model: Scenario, query: ExpectedQuery): Record<string, string | number | null>[] {
  const config = project(model, query.project);
  const at = slots(model, DATASET_OF[query.kind]);
  switch (query.kind) {
    case "worker":
      return at.flatMap(slotMs => WORKER_STATUSES.map(httpStatus => {
        const invocations = values.workerInvocations(model, config.id, slotMs, httpStatus);
        return { ...workerTime(slotMs), httpStatus, entrypoint: null, invocations, cpu_sum: values.workerCpuMs(invocations), cpu_max: values.workerCpuMaxMs(slotMs) };
      }));
    case "route":
      return at.flatMap(slotMs => ROUTE_LABELS.map((invocationLabel, label) => {
        const invocations = values.routeInvocations(config.id, slotMs, label);
        return { ...workerTime(slotMs), invocationLabel, entrypoint: null, invocations, cpu_sum: values.workerCpuMs(invocations) };
      }));
    case "durableObjects":
      return at.map(slotMs => {
        const invocations = values.durableObjectInvocations(config.id, slotMs);
        return { bucket: datetime(slotMs), status: "success", invocations, cpu_us: invocations * 1500, wall_us: invocations * 4000, cpu_max_us: 2500 };
      });
    case "r2Operations":
      return at.flatMap(slotMs => config.buckets.flatMap(bucketName => R2_ACTIONS.map((actionStatus, action) => ({ bucketName, bucket: datetime(slotMs), actionStatus, operations: values.r2Operations(bucketName, slotMs, action) }))));
    case "r2Storage":
      return at.flatMap(slotMs => config.buckets.map(bucketName => ({ bucketName, bucket: datetime(slotMs), storage_bytes: values.r2StorageBytes(bucketName, slotMs), objects: values.r2Objects(bucketName, slotMs) })));
    case "d1":
      return at.map(slotMs => {
        const perStatement = D1_STATEMENTS.map((_, statement) => values.d1Queries(config.id, slotMs, statement));
        return {
          bucket: datetime(slotMs),
          queries: perStatement.reduce((sum, queries) => sum + queries, 0),
          rows_read: perStatement.reduce((sum, queries) => sum + values.d1RowsRead(queries), 0),
          rows_written: perStatement.reduce((sum, queries, statement) => sum + values.d1RowsWritten(queries, statement), 0)
        };
      });
    case "d1Statements":
      return at.flatMap(slotMs => D1_STATEMENTS.map((statement, index) => {
        const queries = values.d1Queries(config.id, slotMs, index);
        return { bucket: datetime(slotMs), statement, queries, rows_read: values.d1RowsRead(queries), rows_written: values.d1RowsWritten(queries, index) };
      }));
    case "d1Storage":
      return at.flatMap(slotMs => config.d1Databases.map(databaseId => ({ databaseId, bucket: datetime(slotMs), size_bytes: values.d1SizeBytes(databaseId, slotMs) })));
  }
}
