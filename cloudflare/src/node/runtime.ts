import { readdirSync, statSync } from "node:fs";
import { constants, monitorEventLoopDelay, performance, PerformanceObserver } from "node:perf_hooks";
import type { MetricStore } from "../metrics/store.ts";
import type { NodeApplicationEvents } from "./application.ts";

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
      atMs: Date.now(),
      process: { cpuUserUs: cpu.user, cpuSystemUs: cpu.system, rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal, externalBytes: memory.external, arrayBuffersBytes: memory.arrayBuffers, openFds, startTimeMs: this.startTimeMs },
      eventLoop: { delayP50Ns: this.histogram.percentile(50), delayP99Ns: this.histogram.percentile(99), delayMaxNs: this.histogram.max, utilization: this.utilization },
      gc: structuredClone(this.gc), activeRequests: this.activeRequests, inflightStreams: this.streams, responseBytes: this.bytes,
      sqlite: Object.fromEntries([...this.databases].map(([name, state]) => [name, { statements: state.statements, statementUs: state.statementUs, transactions: state.transactions, transactionUs: state.transactionUs, busy: state.busy, rowsRead: null, mainBytes: size(state.path), walBytes: size(`${state.path}-wal`), checkpoint: state.checkpoint, retentionLatenessMs: state.retentionLatenessMs }])),
      telemetry: this.application?.stats() ?? null, exportFailures: this.exportFailures
    };
  }

  sample(): void {
    const current = performance.eventLoopUtilization();
    this.utilization = performance.eventLoopUtilization(current, this.previousUtilization).utilization;
    this.previousUtilization = current;
    const snapshot = this.snapshot();
    try { this.store().recordNativeRuntime(snapshot.atMs, JSON.stringify(snapshot)); }
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
