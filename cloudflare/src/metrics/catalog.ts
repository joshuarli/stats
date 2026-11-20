export type Family = {
  source: "engine" | "rivetkit" | "openorange";
  type: "counter" | "gauge" | "histogram";
  form: "u64" | "decimal";
  labels: Record<string, readonly string[]>;
  buckets?: readonly string[];
};

const worker = { actor_name: ["openorange:cron@serve-primary"] };
const entry = (source: Family["source"], type: Family["type"], labels: Family["labels"] = {}, form: Family["form"] = "u64"): Family => ({ source, type, labels, form });
export const catalog: Record<string, Family> = {
  openorange_worker_info: entry("openorange", "gauge", { worker: ["serve-primary", "serve-peer"], index: ["0", "1"] }),
  openorange_worker_start_time_seconds: entry("openorange", "gauge", {}, "decimal"),
  rivet_rivetkit_actor_active_count: entry("rivetkit", "gauge", worker),
  rivet_rivetkit_actor_http_requests_active: entry("rivetkit", "gauge", worker),
  rivet_rivetkit_actor_inbox_depth: entry("rivetkit", "gauge", { ...worker, inbox: ["dispatch", "lifecycle"] }),
  rivet_rivetkit_actor_started_total: entry("rivetkit", "counter", worker),
  rivet_rivetkit_sqlite_worker_inflight: entry("rivetkit", "gauge", worker),
  rivet_rivetkit_sqlite_worker_queue_depth: entry("rivetkit", "gauge", worker),
  rivet_rivetkit_envoy_client_actor_queued_requests: entry("rivetkit", "gauge"),
  rivet_rivetkit_envoy_client_actor_queued_requests_capacity: entry("rivetkit", "gauge"),
  rivet_rivetkit_envoy_client_actor_queued_requests_overloaded_total: entry("rivetkit", "counter"),
  rivet_rivetkit_envoy_client_sqlite_requests_inflight: entry("rivetkit", "gauge"),
  rivet_rivetkit_envoy_client_http_detached_send_dropped_total: entry("rivetkit", "counter"),
  rivet_rivetkit_envoy_client_actor_start_seconds: {
    ...entry("rivetkit", "histogram"),
    buckets: ["0.002", "0.004", "0.006", "0.008", "0.01", "0.012", "0.015", "0.02", "0.025", "0.03", "0.04", "0.05", "0.065", "0.08", "0.1", "0.13", "0.16", "0.2", "0.25", "0.32", "0.4", "0.5", "0.75", "1", "1.5", "2.5", "5", "10", "30", "60", "+Inf"]
  },
  rivet_topology_discovery_heartbeat_reads_total: entry("engine", "counter", { result: ["read"] }),
  rivet_topology_heartbeat_gc_passes_total: entry("engine", "counter", { result: ["completed"] }),
  rivet_state_machine_durable_stale_alarm_deliveries_total: entry("engine", "counter", { machine: ["actor"] }),
  rivet_depot_alarm_discovery_rows_total: entry("engine", "counter"),
  rivet_depot_client_fences_total: entry("engine", "counter", { reason: ["commit_driver_abandoned", "owner_released", "slot_closed", "speculation_lost"] }),
  rivet_depot_cold_store_backpressure_total: entry("engine", "counter", { result: ["timeout", "wait"] }),
  rivet_depot_cold_store_unflushed_bytes: entry("engine", "gauge"),
  rivet_depot_cold_store_unflushed_capacity_bytes: entry("engine", "gauge"),
  rivet_depot_tablet_flush_deferred_volumes_total: entry("engine", "counter"),
  rivet_depot_tablet_store_queue_depth: entry("engine", "gauge", { kind: ["sampled_apply", "sampled_flush", "sampled_load", "sampled_open", "sampled_other", "sampled_pass", "sampled_row_read", "session_read", "store"] }),
  rivet_depot_tablet_volume_refusals_total: entry("engine", "counter", { reason: ["not_maintainer", "volume_not_found"] })
};
