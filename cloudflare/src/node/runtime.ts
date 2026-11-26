import { readdirSync, statSync } from "node:fs";
import { constants, monitorEventLoopDelay, performance, PerformanceObserver } from "node:perf_hooks";
import type { NativeMetricName, NativeMetricValue } from "../metrics/catalog.ts";
import type { MetricStore } from "../metrics/store.ts";
import type { NodeApplicationEvents } from "./application.ts";

export interface RuntimeIdentity {
  readonly release: string | null;
  readonly sourceCommit: string | null;
  readonly node: string;
  readonly schemas: { readonly installation: number; readonly applicationEvents: number; readonly metrics: string; readonly metricsCatalog: number; readonly observations: null };
}

export interface SqlObservation {
  measure<T>(kind: "statement" | "transaction", operation: () => T): T;
}

interface DatabaseState {
  path: string;
  statements: number;
  statementUs: number;
  transactions: number;
  transactionUs: number;
  busy: number;
  retentionLatenessMs: number | null;
  checkpoint: { busy: number; log: number; checkpointed: number } | null;
}

function size(path: string): number | null {
  try { return statSync(path).size; } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
    return null;
  }
}

export class NodeRuntime {
  private readonly databases = new Map<string, DatabaseState>();
  private readonly histogram = monitorEventLoopDelay({ resolution: 20 });
  private readonly observer: PerformanceObserver;
  private readonly gc: Record<string, { count: number; pauseUs: number }> = {};
  private readonly startTimeMs = Math.round(Date.now() - process.uptime() * 1000);
  private readonly timer: NodeJS.Timeout;
  private readonly store: () => MetricStore;
  private previousUtilization = performance.eventLoopUtilization();
  private utilization = 0;
  private activeRequests = 0;
  private streams = 0;
  private bytes = 0;
  private exportFailures = 0;
  private application: NodeApplicationEvents | undefined;
  private identity: RuntimeIdentity | null = null;

  constructor(store: () => MetricStore, intervalMs = 10_000) {
    this.store = store;
    this.histogram.enable();
    this.observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        const detail = "detail" in entry ? entry.detail : undefined;
        const kind = typeof detail === "object" && detail !== null && "kind" in detail ? detail.kind : undefined;
        const name = kind === constants.NODE_PERFORMANCE_GC_MAJOR ? "major" : kind === constants.NODE_PERFORMANCE_GC_MINOR ? "minor" : kind === constants.NODE_PERFORMANCE_GC_INCREMENTAL ? "incremental" : kind === constants.NODE_PERFORMANCE_GC_WEAKCB ? "weakcb" : "other";
        const current = this.gc[name] ?? { count: 0, pauseUs: 0 };
        current.count += 1;
        current.pauseUs += Math.round(entry.duration * 1000);
        this.gc[name] = current;
      }
    });
    this.observer.observe({ entryTypes: ["gc"] });
    this.timer = setInterval(() => this.sample(), intervalMs);
    this.timer.unref();
  }

  setIdentity(identity: RuntimeIdentity): void { this.identity = identity; }
  attachApplication(application: NodeApplicationEvents | undefined): void { this.application = application; }
  requestStarted(): void { this.activeRequests += 1; }
  requestFinished(): void { this.activeRequests -= 1; }
  streamStarted(): void { this.streams += 1; }
  streamFinished(): void { this.streams -= 1; }
  responseBytes(bytes: number): void { this.bytes += bytes; }

  database(name: string, path: string): SqlObservation {
    const state: DatabaseState = { path, statements: 0, statementUs: 0, transactions: 0, transactionUs: 0, busy: 0, retentionLatenessMs: null, checkpoint: null };
    this.databases.set(name, state);
    return { measure: (kind, operation) => {
      const started = performance.now();
      try { return operation(); } catch (error) {
        if (error instanceof Error && "errcode" in error && (typeof error.errcode === "number" && ((error.errcode & 255) === 5 || (error.errcode & 255) === 6))) state.busy += 1;
        throw error;
      } finally {
        const elapsed = Math.max(0, Math.round((performance.now() - started) * 1000));
        if (kind === "statement") { state.statements += 1; state.statementUs += elapsed; }
        else { state.transactions += 1; state.transactionUs += elapsed; }
      }
    } };
  }

  retention(name: string, latenessMs: number): void {
    const state = this.databases.get(name);
    if (state !== undefined) state.retentionLatenessMs = latenessMs;
  }

  checkpoint(name: string, result: { busy: number; log: number; checkpointed: number }): void {
    const state = this.databases.get(name);
    if (state !== undefined) state.checkpoint = result;
  }

  snapshot() {
    const cpu = process.cpuUsage();
    const memory = process.memoryUsage();
    let openFds: number | null = null;
    if (process.platform === "linux") {
      try { openFds = readdirSync("/proc/self/fd").length; } catch { openFds = null; }
    }
    return {
      atMs: Date.now(), identity: this.identity,
      process: { cpuUserUs: cpu.user, cpuSystemUs: cpu.system, rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal, externalBytes: memory.external, arrayBuffersBytes: memory.arrayBuffers, openFds, startTimeMs: this.startTimeMs },
      eventLoop: { delayP50Ns: this.histogram.percentile(50), delayP99Ns: this.histogram.percentile(99), delayMaxNs: this.histogram.max, utilization: this.utilization },
      gc: structuredClone(this.gc), activeRequests: this.activeRequests, inflightStreams: this.streams, responseBytes: this.bytes,
      sqlite: Object.fromEntries([...this.databases].map(([name, state]) => [name, { statements: state.statements, statementUs: state.statementUs, transactions: state.transactions, transactionUs: state.transactionUs, busy: state.busy, rowsRead: null, mainBytes: size(state.path), walBytes: size(`${state.path}-wal`), checkpoint: state.checkpoint, retentionLatenessMs: state.retentionLatenessMs }])),
      telemetry: this.application?.stats() ?? null, exportFailures: this.exportFailures
    };
  }

  private families(snapshot: ReturnType<NodeRuntime["snapshot"]>): Record<NativeMetricName, NativeMetricValue> {
    const databases = Object.entries(snapshot.sqlite);
    const database = (field: "statements" | "statementUs" | "transactions" | "transactionUs" | "busy" | "mainBytes" | "walBytes" | "retentionLatenessMs") => Object.fromEntries(databases.map(([name, state]) => [name, state[field]]));
    const checkpoint = (field: "busy" | "log" | "checkpointed") => Object.fromEntries(databases.map(([name, state]) => [name, state.checkpoint?.[field] ?? null]));
    const gc = (field: "count" | "pauseUs") => Object.fromEntries(Object.entries(snapshot.gc).map(([kind, state]) => [kind, state[field]]));
    return {
      cpu_user_us: snapshot.process.cpuUserUs, cpu_system_us: snapshot.process.cpuSystemUs, rss_bytes: snapshot.process.rssBytes,
      heap_used_bytes: snapshot.process.heapUsedBytes, heap_total_bytes: snapshot.process.heapTotalBytes, external_bytes: snapshot.process.externalBytes,
      array_buffers_bytes: snapshot.process.arrayBuffersBytes, open_fds: snapshot.process.openFds, start_time_ms: snapshot.process.startTimeMs,
      event_loop_delay_p50_ns: snapshot.eventLoop.delayP50Ns, event_loop_delay_p99_ns: snapshot.eventLoop.delayP99Ns,
      event_loop_delay_max_ns: snapshot.eventLoop.delayMaxNs, event_loop_utilization: snapshot.eventLoop.utilization,
      gc_count: gc("count"), gc_pause_us: gc("pauseUs"), active_requests: snapshot.activeRequests, inflight_streams: snapshot.inflightStreams,
      response_bytes: snapshot.responseBytes, sqlite_statements: database("statements"), sqlite_statement_us: database("statementUs"),
      sqlite_transactions: database("transactions"), sqlite_transaction_us: database("transactionUs"), sqlite_busy: database("busy"),
      sqlite_main_bytes: database("mainBytes"), sqlite_wal_bytes: database("walBytes"), sqlite_retention_lateness_ms: database("retentionLatenessMs"),
      sqlite_checkpoint_busy: checkpoint("busy"), sqlite_checkpoint_log: checkpoint("log"), sqlite_checkpoint_checkpointed: checkpoint("checkpointed"),
      telemetry_admitted: snapshot.telemetry?.admitted ?? null, telemetry_sent: snapshot.telemetry?.sent ?? null,
      telemetry_dropped: snapshot.telemetry?.dropped ?? null, telemetry_retried: snapshot.telemetry?.retries ?? null,
      telemetry_queue_high: snapshot.telemetry?.queueHigh ?? null
    };
  }

  sample(): void {
    const current = performance.eventLoopUtilization();
    this.utilization = performance.eventLoopUtilization(current, this.previousUtilization).utilization;
    this.previousUtilization = current;
    const snapshot = this.snapshot();
    try { this.store().recordNativeRuntime(snapshot.atMs, JSON.stringify({ families: this.families(snapshot) })); }
    catch (error) {
      this.exportFailures += 1;
      console.error(JSON.stringify({ event: "runtime_sample_failed", name: error instanceof Error ? error.name : typeof error }));
    }
    this.histogram.reset();
  }

  stop(): void {
    clearInterval(this.timer);
    this.histogram.disable();
    this.observer.disconnect();
  }
}
