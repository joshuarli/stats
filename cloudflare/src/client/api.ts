import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const CpuSchema = Schema.Struct({
  user: Schema.Number,
  system: Schema.Number,
  idle: Schema.Number,
  iowait: Schema.Number,
  steal: Schema.Number
});

const LoadSchema = Schema.Struct({
  one: Schema.Number,
  five: Schema.Number,
  fifteen: Schema.Number
});

const MemSchema = Schema.Struct({
  total: Schema.Number,
  available: Schema.Number,
  swapUsed: Schema.Number
});

const PsiGroupSchema = Schema.Struct({
  some10: Schema.Number,
  some60: Schema.Number,
  some300: Schema.Number
});

const PsiSchema = Schema.Struct({
  cpu: Schema.optional(PsiGroupSchema),
  memory: Schema.optional(PsiGroupSchema),
  io: Schema.optional(PsiGroupSchema)
});

const SummaryPointSchema = Schema.Struct({
  atMs: Schema.Number,
  coverageMs: Schema.Number,
  partial: Schema.Boolean,
  cpu: Schema.optional(CpuSchema),
  load: Schema.optional(LoadSchema),
  mem: Schema.optional(MemSchema),
  psi: Schema.optional(PsiSchema)
});

const DiskPointSchema = Schema.Struct({
  atMs: Schema.Number,
  readBytesPerSec: Schema.Number,
  writeBytesPerSec: Schema.Number,
  readsPerSec: Schema.Number,
  writesPerSec: Schema.Number,
  busyPct: Schema.Number
});

const NetPointSchema = Schema.Struct({
  atMs: Schema.Number,
  rxBytesPerSec: Schema.Number,
  txBytesPerSec: Schema.Number,
  rxPacketsPerSec: Schema.Number,
  txPacketsPerSec: Schema.Number,
  rxDropsPerSec: Schema.Number,
  txDropsPerSec: Schema.Number,
  rxErrorsPerSec: Schema.Number,
  txErrorsPerSec: Schema.Number
});

const FilesystemPointSchema = Schema.Struct({
  atMs: Schema.Number,
  total: Schema.Number,
  available: Schema.Number
});

const BlockPointSchema = Schema.Struct({
  atMs: Schema.Number,
  count: Schema.Number,
  totalUs: Schema.Number,
  minUs: Schema.Number,
  maxUs: Schema.Number,
  p50Us: Schema.Number,
  p95Us: Schema.Number,
  p99Us: Schema.Number
});

const HostSchema = Schema.Struct({
  hostId: Schema.String,
  name: Schema.String,
  createdAtMs: Schema.Number,
  revoked: Schema.Boolean,
  lastReceivedAtMs: Schema.NullOr(Schema.Number),
  online: Schema.Boolean
});

const HostListSchema = Schema.Struct({
  hosts: Schema.Array(HostSchema)
});

const SampleSchema = Schema.Struct({
  seq: Schema.String,
  atMs: Schema.String,
  monoMs: Schema.String,
  uptimeMs: Schema.optional(Schema.String),
  cpuCount: Schema.optional(Schema.Number)
});

const LatestSchema = Schema.Struct({
  hostId: Schema.String,
  receivedAtMs: Schema.Number,
  sample: SampleSchema
});

const historyFields = {
  hostId: Schema.String,
  range: Schema.String,
  fromMs: Schema.Number,
  toMs: Schema.Number,
  resolution: Schema.Literals(["raw", "1m", "1h"]),
  stepMs: Schema.Number
};

const SummaryHistorySchema = Schema.Struct({
  ...historyFields,
  kind: Schema.Literal("summary"),
  points: Schema.optional(Schema.Array(SummaryPointSchema))
});

const DiskSeriesSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  points: Schema.Array(DiskPointSchema)
});

const DiskHistorySchema = Schema.Struct({
  ...historyFields,
  kind: Schema.Literal("disks"),
  series: Schema.optional(Schema.Array(DiskSeriesSchema))
});

const NetSeriesSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  points: Schema.Array(NetPointSchema)
});

const NetHistorySchema = Schema.Struct({
  ...historyFields,
  kind: Schema.Literal("nets"),
  series: Schema.optional(Schema.Array(NetSeriesSchema))
});

const FilesystemSeriesSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  points: Schema.Array(FilesystemPointSchema)
});

const FilesystemHistorySchema = Schema.Struct({
  ...historyFields,
  kind: Schema.Literal("filesystems"),
  series: Schema.optional(Schema.Array(FilesystemSeriesSchema))
});

const BlockSeriesSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  points: Schema.Array(BlockPointSchema)
});

const BlockHistorySchema = Schema.Struct({
  ...historyFields,
  kind: Schema.Literal("block"),
  series: Schema.optional(Schema.Array(BlockSeriesSchema))
});

export type Host = Schema.Schema.Type<typeof HostSchema>;
export type Psi = Schema.Schema.Type<typeof PsiSchema>;
export type SummaryPoint = Schema.Schema.Type<typeof SummaryPointSchema>;
export type DiskPoint = Schema.Schema.Type<typeof DiskPointSchema>;
export type NetPoint = Schema.Schema.Type<typeof NetPointSchema>;
export type FilesystemPoint = Schema.Schema.Type<typeof FilesystemPointSchema>;
export type BlockPoint = Schema.Schema.Type<typeof BlockPointSchema>;
export type Latest = Schema.Schema.Type<typeof LatestSchema>;
export type SummaryHistory = Schema.Schema.Type<typeof SummaryHistorySchema>;
export type DiskSeries = Schema.Schema.Type<typeof DiskSeriesSchema>;
export type NetSeries = Schema.Schema.Type<typeof NetSeriesSchema>;
export type FilesystemSeries = Schema.Schema.Type<typeof FilesystemSeriesSchema>;
export type BlockSeries = Schema.Schema.Type<typeof BlockSeriesSchema>;

export class ApiFailure extends Schema.TaggedError<ApiFailure>()("ApiFailure", {
  status: Schema.Number,
  message: Schema.String
}) {}

function failureMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "The request was cancelled.";
  return error instanceof Error ? error.message : "The request could not be sent.";
}

function statusMessage(status: number): string {
  if (status === 401 || status === 403) return "Sign in through Cloudflare Access.";
  if (status === 404) return "No telemetry is stored for this host.";
  if (status === 429) return "Telemetry is rate limited. Try again shortly.";
  return `The telemetry service returned ${status}.`;
}

function getJson<S extends Schema.ConstraintDecoder<unknown>>(path: string, schema: S, signal: AbortSignal): Effect.Effect<S["Type"], ApiFailure> {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => fetch(path, { headers: { Accept: "application/json" }, cache: "no-store", signal }),
      catch: error => new ApiFailure({ status: 0, message: failureMessage(error) })
    });
    if (!response.ok) {
      return yield* new ApiFailure({ status: response.status, message: statusMessage(response.status) });
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return yield* new ApiFailure({ status: 0, message: "The response was not telemetry JSON. Sign in through Cloudflare Access." });
    }
    const body = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => new ApiFailure({ status: 0, message: "The response was not valid JSON." })
    });
    return yield* Effect.try({
      try: () => Schema.decodeUnknownSync(schema)(body),
      catch: () => new ApiFailure({ status: 0, message: "The response did not match the telemetry contract." })
    });
  });
}

const hostPath = (hostId: string, suffix = "") => `/api/v1/hosts/${encodeURIComponent(hostId)}${suffix}`;

export function getHosts(signal: AbortSignal): Effect.Effect<readonly Host[], ApiFailure> {
  return getJson("/api/v1/hosts", HostListSchema, signal).pipe(Effect.map(value => value.hosts));
}

export function getLatest(hostId: string, signal: AbortSignal): Effect.Effect<Latest | null, ApiFailure> {
  return getJson(hostPath(hostId, "/latest"), LatestSchema, signal).pipe(
    Effect.catch(error => error.status === 404 ? Effect.succeed(null) : Effect.fail(error))
  );
}

export function getSummary(hostId: string, range: string, signal: AbortSignal): Effect.Effect<SummaryHistory, ApiFailure> {
  return getJson(`${hostPath(hostId, "/history")}?range=${encodeURIComponent(range)}&kind=summary`, SummaryHistorySchema, signal);
}

export function getDisks(hostId: string, range: string, signal: AbortSignal): Effect.Effect<DiskHistory, ApiFailure> {
  return getJson(`${hostPath(hostId, "/history")}?range=${encodeURIComponent(range)}&kind=disks`, DiskHistorySchema, signal);
}

export function getNets(hostId: string, range: string, signal: AbortSignal): Effect.Effect<NetHistory, ApiFailure> {
  return getJson(`${hostPath(hostId, "/history")}?range=${encodeURIComponent(range)}&kind=nets`, NetHistorySchema, signal);
}

export function getFilesystems(hostId: string, range: string, signal: AbortSignal): Effect.Effect<FilesystemHistory, ApiFailure> {
  return getJson(`${hostPath(hostId, "/history")}?range=${encodeURIComponent(range)}&kind=filesystems`, FilesystemHistorySchema, signal);
}

export function getBlock(hostId: string, range: string, signal: AbortSignal): Effect.Effect<BlockHistory, ApiFailure> {
  return getJson(`${hostPath(hostId, "/history")}?range=${encodeURIComponent(range)}&kind=block`, BlockHistorySchema, signal);
}

export type DiskHistory = Schema.Schema.Type<typeof DiskHistorySchema>;
export type NetHistory = Schema.Schema.Type<typeof NetHistorySchema>;
export type FilesystemHistory = Schema.Schema.Type<typeof FilesystemHistorySchema>;
export type BlockHistory = Schema.Schema.Type<typeof BlockHistorySchema>;

export async function run<A>(effect: Effect.Effect<A, ApiFailure>): Promise<A> {
  return Effect.runPromise(effect);
}
