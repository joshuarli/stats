import { OPERATIONS } from "../producer/channel.ts";
import type { ObservedService } from "../services.ts";
import { NANOSHOP_OPERATIONS, NANOSHOP_ROUTES_PER_CLASS, NANOSHOP_SAMPLING, nanoshopLabelOperation, nanoshopWorkerRoute } from "./nanoshop-policy.ts";
import { MAX_OUTCOME_ROUTES_PER_CLASS } from "./limits.ts";
import type { CountingPolicy } from "./store.ts";
import type { Stage } from "./model.ts";
import { KEEP_ALL } from "./sampling.ts";
import { INGEST_PATH, RETIRED_INGEST_PATHS } from "../../ingest/http.ts";

export interface ServicePolicy extends CountingPolicy {
  readonly workerRoute: (path: string) => string | null;
  readonly objectRoute: (path: string) => string | null;
  readonly operations: ReadonlySet<string>;
  readonly labelOperation: (stage: Stage, label: string) => string | null;
  readonly operationMessages: "stats" | "service";
}

const SERVICE_MARKER_PATH = /^\/ingest\/services\/[^/]+\/deployments$/u;
const HOST_ID = /^h_[0-9a-f]{32}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function statsTemplate(path: string): string {
  const segments = path.split("/");
  return segments.map((segment, index) => {
    if (HOST_ID.test(segment)) return ":host";
    if (UUID.test(segment)) return ":id";
    if (index > 0 && segments[index - 1] === "projects") return ":project";
    if (index > 0 && segments[index - 1] === "services") return ":service";
    return segment;
  }).join("/");
}

function statsWorkerRoute(path: string): string | null {
  if (path === INGEST_PATH || RETIRED_INGEST_PATHS.has(path)) return path;
  if (path.startsWith("/api/v1/")) return `/api/v1${statsTemplate(path.slice("/api/v1".length))}`;
  if (SERVICE_MARKER_PATH.test(path)) return statsTemplate(path);
  return null;
}

const MEMORIES_SEGMENTS: ReadonlySet<string> = new Set([
  "api", "v1", "sync", "hello", "objects", "missing", "snapshots", "gc", "generations", "manifests", "tombstones",
  "learning", "state", "keys", "deltas", "reconcile", "memories", "status", "search", "m"
]);

function memoriesWorkerRoute(path: string): string {
  if (path === "/") return path;
  return path.split("/").map((segment, index) => index === 0 || MEMORIES_SEGMENTS.has(segment) ? segment : ":id").join("/");
}

export const MEMORIES_OPERATIONS = [
  "request.auth", "request.route", "sync.replace", "snapshots.commit", "generations.commit",
  "sync.hello", "sync.missing", "sync.upload", "snapshots.page", "snapshots.verify", "snapshots.gc",
  "tombstones.commit", "learning.state", "learning.delta", "learning.reconcile", "memories.search",
  "status.read", "mcp.request"
] as const;

export const POLICIES: Readonly<Record<ObservedService, ServicePolicy>> = {
  stats: {
    workerRoute: statsWorkerRoute,
    objectRoute: path => path === "/" ? null : statsTemplate(path),
    operations: new Set(OPERATIONS),
    labelOperation: () => null,
    operationMessages: "stats",
    sampling: KEEP_ALL,
    routesPerClass: MAX_OUTCOME_ROUTES_PER_CLASS
  },
  "usr-memories": {
    workerRoute: memoriesWorkerRoute,
    objectRoute: () => null,
    operations: new Set(MEMORIES_OPERATIONS),
    labelOperation: () => null,
    operationMessages: "service",
    sampling: KEEP_ALL,
    routesPerClass: MAX_OUTCOME_ROUTES_PER_CLASS
  },
  "nanoshop-storied": {
    workerRoute: nanoshopWorkerRoute,
    objectRoute: () => null,
    operations: new Set(NANOSHOP_OPERATIONS),
    labelOperation: nanoshopLabelOperation,
    operationMessages: "service",
    sampling: NANOSHOP_SAMPLING,
    routesPerClass: NANOSHOP_ROUTES_PER_CLASS
  },
  "nanoshop-fieldhouse": {
    workerRoute: nanoshopWorkerRoute,
    objectRoute: () => null,
    operations: new Set(NANOSHOP_OPERATIONS),
    labelOperation: nanoshopLabelOperation,
    operationMessages: "service",
    sampling: NANOSHOP_SAMPLING,
    routesPerClass: NANOSHOP_ROUTES_PER_CLASS
  },
  "nanoshop-tidewater": {
    workerRoute: nanoshopWorkerRoute,
    objectRoute: () => null,
    operations: new Set(NANOSHOP_OPERATIONS),
    labelOperation: nanoshopLabelOperation,
    operationMessages: "service",
    sampling: NANOSHOP_SAMPLING,
    routesPerClass: NANOSHOP_ROUTES_PER_CLASS
  }
};
