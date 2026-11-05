import type { SampleRejection } from "../../ingest/ack.ts";

export const OBSERVE_CHANNEL = "stats.observe";

export const OPERATIONS = [
  "installation.request",
  "projects.config",
  "collector.record",
  "deployments.collect",
  "deployments.poll",
  "deployments.record",
  "deployments.version",
  "deployments.coverage",
  "deployments.retention",
  "deployments.api",
  "deployments.forward"
] as const;

export type Operation = typeof OPERATIONS[number];

export interface InvocationMark {
  readonly kind: "invocation";
  readonly traceId: string;
  readonly spanId: string;
}

export interface ErrorReport {
  readonly kind: "error";
  readonly operation: Operation;
  readonly name: string;
  readonly message: string;
  readonly stack: string | null;
}

export const OPERATION_IDS = ["host.ingest", "host.history", "project.history", "collector.record", "cleanup.retention", "deployments.poll"] as const;

export type OperationId = typeof OPERATION_IDS[number];

export const WORKLOAD_CLASS = /^[a-z0-9][a-z0-9_.:+-]{0,63}$/u;

export interface RowAccount {
  readonly read: number;
  readonly written: number;
  readonly statements: number;
}

export interface IngestWork {
  readonly received: number;
  readonly persisted: number;
  readonly duplicate: number;
  readonly rejected: Readonly<Record<SampleRejection, number>>;
  readonly inputBytes: number;
}

export interface HistoryWork {
  readonly points: number;
  readonly cells: number;
  readonly outputBytes: number;
  readonly cache: "hit-304" | "rebuilt";
}

export interface CollectorWork {
  readonly runs: number;
  readonly metricRows: number;
  readonly hourRollups: number;
  readonly upstreamQueries: number;
}

export interface RetentionWork {
  readonly expired: number;
  readonly backlog: number;
}

export type OperationSummary = { readonly synthetic: boolean; readonly rows: RowAccount } & (
  | { readonly operation: "host.ingest"; readonly work: IngestWork }
  | { readonly operation: "host.history" | "project.history"; readonly workloadClass: string; readonly work: HistoryWork }
  | { readonly operation: "collector.record"; readonly work: CollectorWork }
  | { readonly operation: "cleanup.retention"; readonly work: RetentionWork }
  | { readonly operation: "deployments.poll" }
);

export type OperationMessage = { readonly kind: "operation"; readonly traceId: string; readonly spanId: string } & OperationSummary;

export type ChannelMessage = InvocationMark | ErrorReport | OperationMessage;
