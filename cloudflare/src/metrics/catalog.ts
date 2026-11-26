export { catalog, CATALOG_VERSION } from "../../../packages/infra-collector/src/catalog.ts";
export type { Family } from "../../../packages/infra-collector/src/catalog.ts";

const nativeTypes = {
  cpu_user_us: "counter", cpu_system_us: "counter", rss_bytes: "gauge", heap_used_bytes: "gauge", heap_total_bytes: "gauge",
  external_bytes: "gauge", array_buffers_bytes: "gauge", open_fds: "gauge", start_time_ms: "gauge",
  event_loop_delay_p50_ns: "gauge", event_loop_delay_p99_ns: "gauge", event_loop_delay_max_ns: "gauge", event_loop_utilization: "gauge",
  gc_count: "counter", gc_pause_us: "counter", active_requests: "gauge", inflight_streams: "gauge", response_bytes: "counter",
  sqlite_statements: "counter", sqlite_statement_us: "counter", sqlite_transactions: "counter", sqlite_transaction_us: "counter",
  sqlite_busy: "counter", sqlite_main_bytes: "gauge", sqlite_wal_bytes: "gauge", sqlite_retention_lateness_ms: "gauge",
  sqlite_checkpoint_busy: "gauge", sqlite_checkpoint_log: "gauge", sqlite_checkpoint_checkpointed: "gauge",
  telemetry_admitted: "counter", telemetry_sent: "counter", telemetry_dropped: "counter", telemetry_retried: "counter", telemetry_queue_high: "gauge"
} as const;

export type NativeMetricName = keyof typeof nativeTypes;
export type NativeMetricValue = number | null | Record<string, number | null>;

export const nativeCatalog: Readonly<Record<string, { readonly source: "node"; readonly type: "counter" | "gauge"; readonly form: "decimal" }>> = Object.fromEntries(
  Object.entries(nativeTypes).map(([name, type]) => [name, { source: "node", type, form: "decimal" }])
);
