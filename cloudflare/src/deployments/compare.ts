import { LIST_PRICE_PER_MILLION } from "../cost/pricing.ts";
import { singleVersion, type Deployment } from "./model.ts";

export const DEPLOYMENT_BUCKET_MS = 300_000;
export const COMPARISON_WINDOWS = { "1h": 3_600_000, "6h": 21_600_000, "24h": 86_400_000 } as const;
export type ComparisonWindow = keyof typeof COMPARISON_WINDOWS;
export function isComparisonWindow(value: string): value is ComparisonWindow {
  return Object.hasOwn(COMPARISON_WINDOWS, value);
}
export type MetricRow = { readonly metric: string; readonly bucket_ms: number; readonly value: number };
export interface WindowBounds { readonly fromMs: number; readonly toMs: number }
export type Verdict = "improved" | "regressed" | "unchanged" | "insufficient-data" | "confounded";
export interface MetricComparison {
  readonly metric: string;
  readonly label: string;
  readonly unit: string;
  readonly before: number | null;
  readonly after: number | null;
  readonly delta: number | null;
  readonly deltaPercent: number | null;
  readonly verdict: Verdict;
}
export interface DeploymentComparison {
  readonly deploymentId: string;
  readonly window: ComparisonWindow;
  readonly before: WindowBounds;
  readonly after: WindowBounds;
  readonly readyAtMs: number;
  readonly beforeInvocations: number | null;
  readonly afterInvocations: number | null;
  readonly reasons: readonly string[];
  readonly warnings: readonly string[];
  readonly metrics: readonly MetricComparison[];
}

export function comparisonBounds(atMs: number, window: ComparisonWindow): { before: WindowBounds; after: WindowBounds } {
  const duration = COMPARISON_WINDOWS[window];
  const end = Math.floor(atMs / DEPLOYMENT_BUCKET_MS) * DEPLOYMENT_BUCKET_MS;
  // Exclude the mixed deployment bucket and one complete warm-up bucket.
  const start = Math.ceil(atMs / DEPLOYMENT_BUCKET_MS) * DEPLOYMENT_BUCKET_MS + DEPLOYMENT_BUCKET_MS;
  return { before: { fromMs: end - duration, toMs: end }, after: { fromMs: start, toMs: start + duration } };
}

type Buckets = ReadonlyMap<number, ReadonlyMap<string, number>>;
function bucketRows(rows: readonly MetricRow[]): Buckets {
  const buckets = new Map<number, Map<string, number>>();
  for (const row of rows) {
    if (!Number.isFinite(row.value) || row.value < 0 || row.bucket_ms % DEPLOYMENT_BUCKET_MS !== 0) continue;
    const bucket = buckets.get(row.bucket_ms) ?? new Map<string, number>();
    bucket.set(row.metric, row.value);
    buckets.set(row.bucket_ms, bucket);
  }
  return buckets;
}

type AbsentBucket = "missing" | "idle";

function total(buckets: Buckets, bounds: WindowBounds, metric: string, absent: AbsentBucket, zeroWith?: string): number | null {
  let sum = 0;
  for (let at = bounds.fromMs; at < bounds.toMs; at += DEPLOYMENT_BUCKET_MS) {
    const bucket = buckets.get(at);
    const value = bucket?.get(metric);
    if (value !== undefined) sum += value;
    else if (absent === "missing" && (zeroWith === undefined || bucket?.has(zeroWith) !== true)) return null;
  }
  return Number.isFinite(sum) ? sum : null;
}

function ratio(buckets: Buckets, bounds: WindowBounds, absent: AbsentBucket, numerator: string, denominator: string, scale = 1, zeroWith?: string): number | null {
  const count = total(buckets, bounds, denominator, absent);
  const sum = total(buckets, bounds, numerator, absent, zeroWith);
  return count === null || count < 100 || sum === null ? null : sum / count * scale;
}

function result(metric: string, label: string, unit: string, before: number | null, after: number | null, floor: number, blocked: boolean): MetricComparison {
  const delta = before === null || after === null ? null : after - before;
  const deltaPercent = delta === null || before === null || before === 0 ? null : delta / before * 100;
  const changed = delta !== null && Math.abs(delta) >= floor && (deltaPercent === null || Math.abs(deltaPercent) >= 10);
  const verdict: Verdict = delta === null ? "insufficient-data" : blocked ? "confounded" : changed ? delta > 0 ? "regressed" : "improved" : "unchanged";
  return { metric, label, unit, before, after, delta, deltaPercent, verdict };
}

/** Descriptive comparison, not a causal claim or statistical significance test. */
export function compareDeployment(input: {
  readonly deployment: Deployment;
  readonly deployments: readonly Deployment[];
  readonly rows: readonly MetricRow[];
  readonly window: ComparisonWindow;
  readonly now: number;
  readonly settleMs: number;
  readonly lastSuccessAtMs: number | null;
  readonly truncated: boolean;
  readonly enabled: boolean;
  readonly metricsSettled: boolean;
  readonly hasD1?: boolean;
  readonly hasDurableObjects?: boolean;
  readonly buckets?: readonly string[];
  readonly probes?: readonly string[];
}): DeploymentComparison {
  const { deployment, window } = input;
  const { before, after } = comparisonBounds(deployment.atMs, window);
  const readyAtMs = after.toMs + input.settleMs;
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (!input.metricsSettled) reasons.push("No proof that both metric windows were collected after settlement; historical partial data is not a baseline.");
  if (!input.enabled) reasons.push("Deployment polling is disabled.");
  if (input.now < readyAtMs) reasons.push("Waiting for the full post-deployment window and analytics settlement.");
  if (before.fromMs < input.now - 7 * 86_400_000) reasons.push("Five-minute metrics have expired; hourly rollups cannot safely isolate this deployment.");
  if (input.truncated) reasons.push("Deployment history is truncated.");
  if (input.lastSuccessAtMs === null || input.lastSuccessAtMs < Math.min(after.toMs, input.now) || input.now - input.lastSuccessAtMs > 15 * 60_000) reasons.push("Deployment history has not been refreshed recently enough to exclude intervening releases.");
  if (!singleVersion(deployment)) reasons.push("This deployment splits traffic between versions.");
  const previous = [...input.deployments].filter(item => item.atMs < deployment.atMs).sort((a, b) => b.atMs - a.atMs)[0];
  if (previous === undefined || previous.atMs > before.fromMs) reasons.push("The baseline does not contain one known, stable deployment.");
  else if (!singleVersion(previous)) reasons.push("The baseline splits traffic between versions.");
  if (input.deployments.some(item => item.id !== deployment.id && item.atMs >= before.fromMs && item.atMs < after.toMs && item.id !== (previous?.atMs === before.fromMs ? previous.id : ""))) reasons.push("Another deployment overlaps the comparison windows.");
  const deferredObjects = deployment.deferred || previous?.deferred === true;
  if (deferredObjects) warnings.push("Durable Object code updates are deferred; their metrics are not attributed to this deployment.");
  const buckets = bucketRows(input.rows);
  const analyticsAbsent: AbsentBucket = input.metricsSettled ? "idle" : "missing";
  const beforeCount = total(buckets, before, "worker.invocations", analyticsAbsent);
  const afterCount = total(buckets, after, "worker.invocations", analyticsAbsent);
  if (beforeCount === null || afterCount === null) reasons.push("One or more invocation buckets are missing from a window not yet proven collected; missing data is not zero.");
  else if (beforeCount < 100 || afterCount < 100) reasons.push("Fewer than 100 invocations in a comparison window.");
  if (beforeCount !== null && beforeCount > 0 && afterCount !== null && (afterCount / beforeCount > 2 || afterCount / beforeCount < 0.5)) warnings.push("Traffic volume changed by more than 2x; compare workload and cache behavior.");
  // Top routes are truncated upstream. A large observed shift is enough to withhold
  // a global verdict; a small shift is NOT proof that the full mix stayed constant.
  const routeTotals = (bounds: WindowBounds): Map<string, number> => {
    const values = new Map<string, number>();
    for (const row of input.rows) if (row.bucket_ms >= bounds.fromMs && row.bucket_ms < bounds.toMs && row.metric.startsWith("route.") && row.metric.endsWith(".invocations")) values.set(row.metric, (values.get(row.metric) ?? 0) + row.value);
    return values;
  };
  const left = routeTotals(before), right = routeTotals(after);
  if ((beforeCount ?? 0) > 0 && (afterCount ?? 0) > 0 && left.size > 0 && right.size > 0) {
    const keys = new Set([...left.keys(), ...right.keys()]);
    let variation = 0;
    for (const key of keys) variation += Math.abs((left.get(key) ?? 0) / beforeCount! - (right.get(key) ?? 0) / afterCount!);
    if (variation / 2 > 0.2) reasons.push("Observed top-route traffic mix changed materially (over 20 percentage points).");
  }
  warnings.push("Heuristic signals, not significance tests or proof of causation. Top-route coverage is incomplete; cache, background jobs and traffic can change.");
  const blocked = reasons.length > 0;
  const metrics: MetricComparison[] = [];
  const addRatio = (metric: string, label: string, unit: string, numerator: string, denominator: string, floor: number, scale = 1, zeroWith?: string, extraBlocked = false) => {
    metrics.push(result(metric, label, unit, ratio(buckets, before, analyticsAbsent, numerator, denominator, scale, zeroWith), ratio(buckets, after, analyticsAbsent, numerator, denominator, scale, zeroWith), floor, blocked || extraBlocked));
  };
  addRatio("worker.cpu", "Worker CPU / invocation", "ms", "worker.cpuMsSum", "worker.invocations", 0.1);
  const error = (bounds: WindowBounds) => (total(buckets, bounds, "worker.invocations", analyticsAbsent) ?? 0) < 1000 ? null : ratio(buckets, bounds, analyticsAbsent, "worker.status.5xx", "worker.invocations", 100, "worker.invocations");
  metrics.push(result("worker.errors", "Worker 5xx share (1,000+ invocations)", "%", error(before), error(after), 0.1, blocked));
  if (input.rows.some(row => row.metric === "do.invocations")) {
    addRatio("do.cpu", "Durable Object CPU / invocation", "ms", "do.cpuMsSum", "do.invocations", 0.1, 1, undefined, deferredObjects);
    addRatio("do.wall", "Durable Object wall time / invocation", "ms", "do.wallMsSum", "do.invocations", 1, 1, undefined, deferredObjects);
  }
  if (input.rows.some(row => row.metric === "d1.queries")) {
    addRatio("d1.read", "D1 rows read / Worker invocation", "rows", "d1.rowsRead", "worker.invocations", 1);
    addRatio("d1.write", "D1 rows written / Worker invocation", "rows", "d1.rowsWritten", "worker.invocations", 0.1);
    warnings.push("D1 ratios include background queries and migrations, not just Worker requests.");
  }
  for (const name of input.buckets ?? []) {
    const operations = (bounds: WindowBounds): number | null => {
      const invocations = total(buckets, bounds, "worker.invocations", analyticsAbsent);
      if (invocations === null || invocations < 100) return null;
      let sum = 0;
      for (let at = bounds.fromMs; at < bounds.toMs; at += DEPLOYMENT_BUCKET_MS) {
        const values = ["success", "userError", "other"].map(outcome => buckets.get(at)?.get(`r2.${name}.ops.${outcome}`));
        if (analyticsAbsent === "missing" && values.every(value => value === undefined)) return null;
        sum += values.reduce<number>((value, item) => value + (item ?? 0), 0);
      }
      return sum / invocations;
    };
    metrics.push(result(`r2.${name}`, `R2 ${name} operations / Worker invocation`, "ops", operations(before), operations(after), 0.05, blocked));
  }
  if ((input.buckets?.length ?? 0) > 0) warnings.push("R2 ratios include all clients of the configured bucket, not just this Worker.");
  for (const name of input.probes ?? []) {
    const average = (bounds: WindowBounds, suffix: string): number | null => {
      const sum = total(buckets, bounds, `probe.${name}.${suffix}`, "missing");
      return sum === null ? null : sum / ((bounds.toMs - bounds.fromMs) / DEPLOYMENT_BUCKET_MS);
    };
    metrics.push(result(`probe.${name}.ms`, `Probe ${name} mean edge response time`, "ms", average(before, "ms"), average(after, "ms"), 10, blocked));
    const failures = (bounds: WindowBounds) => { const up = average(bounds, "up"); return up === null ? null : (1 - up) * 100; };
    metrics.push(result(`probe.${name}.failure`, `Probe ${name} failure share`, "%", failures(before), failures(after), 1, blocked));
  }
  const cost = (bounds: WindowBounds): number | null => {
    const requests = total(buckets, bounds, "worker.invocations", analyticsAbsent);
    const cpu = total(buckets, bounds, "worker.cpuMsSum", analyticsAbsent);
    if (requests === null || requests < 100 || cpu === null) return null;
    let price = requests * LIST_PRICE_PER_MILLION.workerRequests + cpu * LIST_PRICE_PER_MILLION.workerCpuMs;
    const parts: readonly [boolean, string, number][] = [
      [input.hasDurableObjects ?? false, "do.invocations", LIST_PRICE_PER_MILLION.durableObjectRequests],
      [input.hasD1 ?? false, "d1.rowsRead", LIST_PRICE_PER_MILLION.d1RowsRead],
      [input.hasD1 ?? false, "d1.rowsWritten", LIST_PRICE_PER_MILLION.d1RowsWritten],
    ];
    for (const [configured, metric, rate] of parts) {
      if (!configured) continue;
      const value = total(buckets, bounds, metric, analyticsAbsent);
      if (value === null) return null;
      price += value * rate;
    }
    return price / requests / 1000;
  };
  metrics.push(result("cost", "Estimated list-price cost / 1,000 invocations", "USD", cost(before), cost(after), 0.000001, blocked || (deferredObjects && (input.hasDurableObjects ?? false))));
  warnings.push("Cost reuses the dashboard's list prices; it excludes allowances, R2, storage and Durable Object duration. Probe times are not user-request latency.");
  return { deploymentId: deployment.id, window, before, after, readyAtMs, beforeInvocations: beforeCount, afterInvocations: afterCount, reasons, warnings, metrics };
}
