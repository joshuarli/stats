export const PLATFORM_SERVICE = "stats-platform";
export const SQLITE_OPERATIONS = ["exec", "execute", "execute_batch", "query", "run", "transaction.begin", "transaction.exec", "transaction.execute", "transaction.commit", "transaction.rollback"] as const;
export type SqliteOperation = typeof SQLITE_OPERATIONS[number];
export const ACTOR_ROLES = ["installation", "observation"] as const;
export type ActorRole = typeof ACTOR_ROLES[number];
export const PLATFORM_OPERATIONS = ACTOR_ROLES.flatMap(role => [`platform.${role}.invoke`, ...SQLITE_OPERATIONS.map(operation => `platform.${role}.sqlite.${operation}`)]);

export const DURATION_BOUNDS_US = [0, 10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000, 2500000, 5000000, 10000000, 60000000, 300000000, 86400000000] as const;
export interface PlatformOperation {
  readonly operation: string;
  readonly release: string;
  readonly count: number;
  readonly failed: number;
  readonly meanUs: number;
  readonly maxUs: number;
  readonly p50UpperUs: number;
  readonly p95UpperUs: number;
  readonly histogram: readonly { readonly upperUs: number; readonly count: number }[];
}
export interface PlatformDelivery {
  readonly atMs: number;
  readonly release: string;
  readonly samplePpm: number;
  readonly received: number;
  readonly admitted: number;
  readonly filtered: number;
  readonly invalid: number;
  readonly dropped: number;
  readonly queued: number;
  readonly sent: number;
  readonly exporterLoss: "unknown";
}
export interface PlatformTelemetry {
  readonly fromMs: number;
  readonly toMs: number;
  readonly operations: readonly PlatformOperation[];
  readonly delivery: PlatformDelivery | null;
  readonly truncated: boolean;
  readonly capabilities: { readonly actorRequests: true; readonly sqlite: true; readonly outboundRpc: false; readonly runtimeMetrics: false };
}
