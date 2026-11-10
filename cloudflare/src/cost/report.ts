import type { TimeWindow } from "../client/chart-data.ts";
import type { Track } from "../client/columns.ts";
import type { MetricHistory } from "../client/history.ts";
import type { ProjectConfig } from "../projects/config.ts";
import { BYTES_PER_GB, DURABLE_OBJECT_MEMORY_GB, PRICING_REVISION } from "./pricing.ts";
import {
  buildLedger, coveredMs, isResidual, MONTH_MS, monthlyOf, monthlyUsage, planBill, projectedBill,
  type Amount, type CostLine, type CostPart, type LedgerHistories, type LineKind, type Meter, type MeterUsage, type ObjectMethods, type Price, type Usage
} from "./ledger.ts";

export class PricingRevisionMismatch extends Error {
  override readonly name = "PricingRevisionMismatch";
}

export type Confidence = "verified" | "qualified" | "unavailable";

export interface Coverage {
  readonly coveredMs: number;
  readonly windowMs: number;
  readonly fraction: number;
}

export interface ReportLine {
  readonly id: string;
  readonly kind: LineKind;
  readonly label: string;
  readonly price: Price;
  readonly parts: readonly CostPart[];
  readonly usage: Usage;
  readonly trend: Track | null;
  readonly coverage: Coverage;
  readonly baselineCoverage: Coverage | null;
  readonly confidence: Confidence;
  readonly children: readonly ReportLine[];
}

export type ExcludedMeter = Meter | "durableObjectSqliteRows" | "r2ClassAOperations" | "r2ClassBOperations";
export type ExclusionReason = "no-data" | "no-source" | "no-action-column" | "tail-cpu-only";

export interface Exclusion {
  readonly meter: ExcludedMeter;
  readonly reason: ExclusionReason;
}

export interface Residual {
  readonly lineId: string;
  readonly label: string;
  readonly monthly: Amount;
}

export interface ReportTotal {
  readonly basis: "list-price-run-rate";
  readonly monthly: Amount;
  readonly pricedMeters: readonly Meter[];
  readonly excluded: readonly Exclusion[];
  readonly residuals: readonly Residual[];
  readonly uncompared: readonly string[];
  readonly confidence: Confidence;
}

export interface Comparison {
  readonly baseline: "present" | "absent";
  readonly change: number | null;
}

export interface RankEntry {
  readonly id: string;
  readonly monthly: number;
  readonly change: number | null;
}

export interface Ranking {
  readonly byCost: readonly RankEntry[];
  readonly byChange: readonly RankEntry[];
}

export type PlanBillReport =
  | {
    readonly kind: "isolated";
    readonly basis: "utc-month";
    readonly assumption: "project-alone-on-account-allowances";
    readonly month: TimeWindow;
    readonly settledMs: number;
    readonly coverage: Coverage;
    readonly usage: Omit<MeterUsage, "workerRequests" | "workerCpuMs" | "d1RowsRead" | "d1RowsWritten"> & { readonly workerRequests: number | null; readonly workerCpuMs: number | null; readonly d1RowsRead: number | null; readonly d1RowsWritten: number | null };
    readonly missingBilledMeters: readonly Meter[];
    readonly missingProjectionMeters: readonly Meter[];
    readonly durationProxy: { readonly billed: boolean; readonly projected: boolean };
    readonly billed: Track;
    readonly billedSoFar: number;
    readonly projected: Track;
    readonly projectedMonthEnd: number;
    readonly account: { readonly kind: "unknown"; readonly reason: "other-projects-not-covered" };
  }
  | { readonly kind: "unavailable"; readonly reason: "month-histories-not-supplied" | "no-data" };

export type WarningCode =
  | "window-ends-after-now"
  | "baseline-unavailable"
  | "baseline-missing"
  | "line-no-data"
  | "line-no-source"
  | "meter-no-data"
  | "route-meter-no-data"
  | "statement-meter-no-data"
  | "window-partial-coverage"
  | "duration-upper-bound-proxy"
  | "object-method-sampled"
  | "unattributed-residual"
  | "tail-requests-unpriced"
  | "plan-month-unavailable"
  | "plan-month-partial"
  | "plan-month-missing-meter"
  | "plan-projection-missing-meter"
  | "plan-duration-upper-bound-proxy";

export interface Warning {
  readonly code: WarningCode;
  readonly subject: string;
  readonly message: string;
}

export interface ReportUnits {
  readonly currency: "USD";
  readonly period: "30-day-month";
  readonly periodMs: number;
  readonly bytesPerGb: number;
  readonly durableObjectMemoryGb: number;
  readonly cpu: "ms";
  readonly wall: "ms";
}

export interface PlanMonthInput {
  readonly histories: LedgerHistories;
  readonly settledMs: number;
}

export interface CostReportInput {
  readonly nowMs: number;
  readonly pricingRevision: string;
  readonly project: ProjectConfig;
  readonly windows: { readonly current: TimeWindow; readonly previous: TimeWindow };
  readonly current: LedgerHistories;
  readonly previous: LedgerHistories | undefined;
  readonly objectMethods: ObjectMethods | undefined;
  readonly planMonth: PlanMonthInput | undefined;
}

export interface CostReport {
  readonly generatedAtMs: number;
  readonly pricingRevision: string;
  readonly project: { readonly id: string; readonly worker: string };
  readonly windows: { readonly current: TimeWindow; readonly previous: TimeWindow };
  readonly units: ReportUnits;
  readonly total: ReportTotal;
  readonly comparison: Comparison;
  readonly lines: readonly ReportLine[];
  readonly ranking: Ranking;
  readonly planBill: PlanBillReport;
  readonly warnings: readonly Warning[];
}

export function utcMonthOf(atMs: number): TimeWindow {
  const at = new Date(atMs);
  return { fromMs: Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1), toMs: Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1) };
}

const UNITS: ReportUnits = { currency: "USD", period: "30-day-month", periodMs: MONTH_MS, bytesPerGb: BYTES_PER_GB, durableObjectMemoryGb: DURABLE_OBJECT_MEMORY_GB, cpu: "ms", wall: "ms" };

function coverageOf(history: MetricHistory | undefined, window: TimeWindow, only?: readonly string[]): Coverage {
  const windowMs = Math.max(0, window.toMs - window.fromMs);
  const covered = history === undefined ? 0 : coveredMs(history, window, only);
  return { coveredMs: covered, windowMs, fraction: windowMs > 0 ? Math.min(1, covered / windowMs) : 0 };
}

interface Source {
  readonly pick: (histories: LedgerHistories) => MetricHistory | undefined;
  readonly only: readonly string[] | undefined;
}

function sourceOf(line: CostLine, parent: Source | null): Source | null {
  const wholly = (pick: Source["pick"]): Source => ({ pick, only: undefined });
  switch (line.kind) {
    case "worker": return wholly(histories => histories.worker);
    case "route": return { pick: histories => histories.routes, only: [`route.${line.label}.invocations`, `route.${line.label}.cpuMsSum`] };
    case "objects": return wholly(histories => histories.durableObjects);
    case "object-method": return parent;
    case "object-storage": return { pick: histories => histories.durableObjects, only: ["do.storageBytes"] };
    case "d1": return wholly(histories => histories.d1);
    case "statement": return { pick: histories => histories.d1Statements, only: [`d1q.${line.label}.queries`, `d1q.${line.label}.rowsRead`, `d1q.${line.label}.rowsWritten`] };
    case "d1-storage": return { pick: histories => histories.d1, only: [`d1.${line.id.slice("d1-storage:".length)}.storageBytes`] };
    case "r2": return wholly(histories => histories.r2);
    case "bucket": return { pick: histories => histories.r2, only: [`r2.${line.label}.storageBytes`] };
    case "unrouted": return parent;
    case "uncollected": return null;
  }
}

function confidenceOf(line: CostLine, coverage: Coverage): Confidence {
  if (line.price.kind === "uncollected") return "unavailable";
  if (line.price.bound === "upper" || isResidual(line)) return "qualified";
  return coverage.fraction === 1 ? "verified" : "qualified";
}

function missingWorkerMeters(histories: LedgerHistories, window: TimeWindow, billing: ProjectConfig["workerBilling"]): Meter[] {
  return [
    ...(billing === "cpu-only" || coveredMs(histories.worker, window, ["worker.invocations"]) > 0 ? [] : ["workerRequests" as const]),
    ...(coveredMs(histories.worker, window, ["worker.cpuMsSum"]) > 0 ? [] : ["workerCpuMs" as const])
  ];
}

function missingD1Meters(histories: LedgerHistories, window: TimeWindow, project: ProjectConfig): Meter[] {
  if (project.d1Databases.length === 0) return [];
  const history = histories.d1;
  return [
    ...(history !== undefined && coveredMs(history, window, ["d1.rowsRead"]) > 0 ? [] : ["d1RowsRead" as const]),
    ...(history !== undefined && coveredMs(history, window, ["d1.rowsWritten"]) > 0 ? [] : ["d1RowsWritten" as const])
  ];
}

function missingMeters(histories: LedgerHistories, window: TimeWindow, project: ProjectConfig): Meter[] {
  return [...missingWorkerMeters(histories, window, project.workerBilling), ...missingD1Meters(histories, window, project)];
}

function reportLine(line: CostLine, parent: Source | null, input: CostReportInput): ReportLine {
  const source = sourceOf(line, parent);
  const window = (previous: boolean) => (previous ? input.windows.previous : input.windows.current);
  const coverage = source === null ? coverageOf(undefined, input.windows.current) : coverageOf(source.pick(input.current), window(false), source.only);
  const baselineCoverage = input.previous === undefined ? null : source === null ? coverageOf(undefined, input.windows.previous) : coverageOf(source.pick(input.previous), window(true), source.only);
  return {
    id: line.id, kind: line.kind, label: line.label, price: line.price, parts: line.parts, usage: line.usage, trend: line.trend,
    coverage, baselineCoverage, confidence: line.price.kind === "priced" && ((line.kind === "worker" && missingWorkerMeters(input.current, input.windows.current, input.project.workerBilling).length > 0) || (line.kind === "d1" && missingD1Meters(input.current, input.windows.current, input.project).length > 0) || (line.kind === "route" && line.usage.kind === "requests" && (line.usage.calls === null || line.usage.cpuMs === null)) || (line.kind === "statement" && line.usage.kind === "rows" && (line.usage.read === null || line.usage.written === null)) || (line.kind === "object-method" && input.objectMethods?.sampling?.now != null)) ? "qualified" : confidenceOf(line, coverage),
    children: line.children.map(child => reportLine(child, source, input))
  };
}

function walk(lines: readonly ReportLine[]): ReportLine[] {
  return lines.flatMap(line => [line, ...walk(line.children)]);
}

const COMPONENT_METERS: Readonly<Record<"worker" | "objects" | "d1" | "r2", readonly Meter[]>> = {
  worker: ["workerRequests", "workerCpuMs"],
  objects: ["durableObjectRequests", "durableObjectGbSeconds", "durableObjectStorage"],
  d1: ["d1RowsRead", "d1RowsWritten", "d1Storage"],
  r2: ["r2Storage"]
};

type Component = keyof typeof COMPONENT_METERS;
const COMPONENTS: readonly Component[] = ["worker", "objects", "d1", "r2"];

function metersOf(lines: readonly ReportLine[], input: CostReportInput): { priced: Meter[]; excluded: Exclusion[] } {
  const project = input.project;
  const missing = missingMeters(input.current, input.windows.current, project);
  const priced = new Set<Meter>();
  const excluded = new Map<ExcludedMeter, ExclusionReason>();
  const configured: Record<Component, boolean> = { worker: true, objects: project.durableObjectNamespaces.length > 0, d1: project.d1Databases.length > 0, r2: project.buckets.length > 0 };
  for (const component of COMPONENTS) {
    if (!configured[component]) continue;
    const line = lines.find(entry => entry.id === component);
    for (const meter of COMPONENT_METERS[component]) {
      if (meter === "workerRequests" && project.workerBilling === "cpu-only") { excluded.set(meter, "tail-cpu-only"); continue; }
      if (missing.includes(meter)) { excluded.set(meter, "no-data"); continue; }
      const storage = meter === "durableObjectStorage" || meter === "d1Storage";
      const hasStorage = line?.children.some(child => child.kind === "object-storage" || child.kind === "d1-storage") ?? false;
      if (line !== undefined && line.price.kind === "priced" && (!storage || hasStorage)) priced.add(meter);
      else excluded.set(meter, "no-data");
    }
  }
  if (configured.objects) excluded.set("durableObjectSqliteRows", "no-source");
  if (configured.r2) { excluded.set("r2ClassAOperations", "no-action-column"); excluded.set("r2ClassBOperations", "no-action-column"); }
  return {
    priced: [...priced].sort(),
    excluded: [...excluded].sort(([left], [right]) => left.localeCompare(right)).map(([meter, reason]) => ({ meter, reason }))
  };
}

function totalConfidence(lines: readonly ReportLine[]): Confidence {
  const priced = lines.filter(line => line.confidence !== "unavailable");
  if (priced.length === 0) return "unavailable";
  return priced.every(line => line.confidence === "verified") ? "verified" : "qualified";
}

function ranking(lines: readonly ReportLine[]): Ranking {
  const entries = walk(lines).filter(line => line.children.length === 0 && !isResidual(line) && line.price.kind === "priced").map((line): RankEntry => {
    const amount = monthlyOf(line);
    return { id: line.id, monthly: amount?.now ?? 0, change: amount === null || amount.before === null ? null : amount.now - amount.before };
  });
  const byCost = [...entries].sort((left, right) => right.monthly - left.monthly || left.id.localeCompare(right.id));
  const byChange = entries.filter(entry => entry.change !== null).sort((left, right) => (right.change ?? 0) - (left.change ?? 0) || left.id.localeCompare(right.id));
  return { byCost, byChange };
}

function warningsFor(input: CostReportInput, lines: readonly ReportLine[], residuals: readonly Residual[], plan: PlanBillReport): Warning[] {
  const warnings: Warning[] = [];
  const warn = (code: WarningCode, subject: string, message: string) => warnings.push({ code, subject, message });
  if (input.windows.current.toMs > input.nowMs) warn("window-ends-after-now", "current", "The current window ends after the report clock, so its newest buckets cannot exist yet.");
  if (input.previous === undefined) warn("baseline-unavailable", "previous", "The previous window was not supplied, so no change is computed.");
  for (const meter of missingMeters(input.current, input.windows.current, input.project)) {
    const label = meter === "workerCpuMs" ? "Worker CPU time" : meter === "workerRequests" ? "Worker requests" : meter === "d1RowsRead" ? "D1 rows read" : "D1 rows written";
    warn("meter-no-data", meter, `${label} ${meter === "workerCpuMs" ? "was" : "were"} not collected in the current window and ${meter === "workerCpuMs" ? "is" : "are"} excluded from the total.`);
  }
  for (const [period, sampling] of [["current", input.objectMethods?.sampling?.now], ["previous", input.objectMethods?.sampling?.before]] as const) {
    if (sampling != null) warn("object-method-sampled", period, `${period === "current" ? "Current" : "Comparison"} object methods: ${sampling.kept} of ${sampling.observed} object invocations retained in overlapping count buckets. ${period === "current" ? "Method counts and latency use retained invocations; cost shares are estimates." : "Comparison values use retained invocations."}`);
  }
  for (const line of walk(lines)) {
    if (line.price.kind === "uncollected") {
      warn(line.price.cause === "no-data" ? "line-no-data" : "line-no-source", line.id, line.price.cause === "no-data" ? `${line.label} has no collected bucket in the window and is excluded from the total.` : `${line.label} has no collector source and is excluded from the total.`);
    }
    if (line.kind === "route" && line.price.kind === "priced" && line.usage.kind === "requests" && (line.usage.calls === null || line.usage.cpuMs === null)) {
      warn("route-meter-no-data", line.id, `${line.label}: ${line.usage.calls === null ? "request" : "CPU"} data was not collected, so its cost is partial.`);
    }
    if (line.kind === "statement" && line.price.kind === "priced" && line.usage.kind === "rows" && (line.usage.read === null || line.usage.written === null)) {
      warn("statement-meter-no-data", line.id, `${line.label}: ${line.usage.read === null ? "rows read" : "rows written"} data was not collected, so its cost is partial.`);
    }
  }
  for (const line of lines) {
    if (line.price.kind !== "priced") continue;
    if (line.coverage.fraction < 1) warn("window-partial-coverage", line.id, `${line.label} is projected from ${line.coverage.coveredMs} of ${line.coverage.windowMs} ms of the window.`);
    if (input.previous !== undefined && line.price.monthly.before === null) warn("baseline-missing", line.id, `${line.label} has no baseline for the previous window.`);
    if (line.price.bound === "upper") warn("duration-upper-bound-proxy", line.id, `${line.label} duration is bounded above by summed request wall time, a proxy for billed duration.`);
  }
  if (input.project.workerBilling === "cpu-only") warn("tail-requests-unpriced", "worker", "Worker invocations are billed by CPU time only, as Tail Worker invocations are; the few fetch and cron requests this Worker also serves are not priced.");
  for (const residual of residuals) warn("unattributed-residual", residual.lineId, `${residual.label} is the part of the total that per-item analytics do not account for.`);
  if (plan.kind === "unavailable") warn("plan-month-unavailable", "plan-bill", plan.reason === "no-data" ? "No month-to-date bucket was collected, so there is no plan bill." : "Month-to-date histories were not supplied, so there is no plan bill.");
  if (plan.kind === "isolated" && plan.coverage.fraction < 1) warn("plan-month-partial", "plan-bill", `The plan bill covers ${(plan.coverage.fraction * 100).toFixed(1)}% of the month so far (${plan.coverage.coveredMs} of ${plan.coverage.windowMs} ms); uncollected time is not priced.`);
  if (plan.kind === "isolated" && plan.missingBilledMeters.length > 0) warn("plan-month-missing-meter", "plan-bill", `The billed amount excludes unavailable meters: ${plan.missingBilledMeters.join(", ")}.`);
  if (plan.kind === "isolated" && plan.missingProjectionMeters.length > 0) warn("plan-projection-missing-meter", "plan-bill", `The projection excludes unavailable meters: ${plan.missingProjectionMeters.join(", ")}.`);
  if (plan.kind === "isolated" && plan.durationProxy.projected) warn("plan-duration-upper-bound-proxy", "plan-bill", "Durable Object summed request wall time is an upper-bound proxy for billed duration and can overestimate the plan amount.");
  return warnings;
}

function planBillReport(input: CostReportInput, monthly: MeterUsage): PlanBillReport {
  if (input.planMonth === undefined) return { kind: "unavailable", reason: "month-histories-not-supplied" };
  const month = utcMonthOf(input.planMonth.settledMs);
  const window = { fromMs: month.fromMs, toMs: Math.max(month.fromMs, input.planMonth.settledMs) };
  const bill = planBill(input.planMonth.histories, window, input.project.buckets, input.project.d1Databases, input.project.workerBilling);
  const coverage = coverageOf(input.planMonth.histories.worker, window);
  if (coverage.fraction === 0) return { kind: "unavailable", reason: "no-data" };
  const missingBilledMeters = missingMeters(input.planMonth.histories, window, input.project);
  const missingProjectionMeters = [...new Set([...missingBilledMeters, ...missingMeters(input.current, input.windows.current, input.project)])];
  const hasDuration = (histories: LedgerHistories, window: TimeWindow) => histories.durableObjects !== undefined && coveredMs(histories.durableObjects, window, ["do.wallMsSum"]) > 0;
  const billedDurationProxy = hasDuration(input.planMonth.histories, window);
  const projected = projectedBill(bill, window.toMs, month.toMs, monthly);
  return {
    kind: "isolated", basis: "utc-month", assumption: "project-alone-on-account-allowances",
    month, settledMs: window.toMs, coverage,
    usage: { ...bill.usage, workerRequests: missingBilledMeters.includes("workerRequests") ? null : bill.usage.workerRequests, workerCpuMs: missingBilledMeters.includes("workerCpuMs") ? null : bill.usage.workerCpuMs, d1RowsRead: missingBilledMeters.includes("d1RowsRead") ? null : bill.usage.d1RowsRead, d1RowsWritten: missingBilledMeters.includes("d1RowsWritten") ? null : bill.usage.d1RowsWritten },
    missingBilledMeters, missingProjectionMeters,
    durationProxy: { billed: billedDurationProxy, projected: billedDurationProxy || hasDuration(input.current, input.windows.current) },
    billed: bill.billed, billedSoFar: bill.billed.values.at(-1) ?? 0,
    projected, projectedMonthEnd: projected.values.at(-1) ?? 0,
    account: { kind: "unknown", reason: "other-projects-not-covered" }
  };
}

export function buildCostReport(input: CostReportInput): CostReport {
  if (input.pricingRevision !== PRICING_REVISION) {
    throw new PricingRevisionMismatch(`pricing revision ${input.pricingRevision} does not match ${PRICING_REVISION}`);
  }
  const ledger = buildLedger({
    current: input.current, previous: input.previous, window: input.windows.current, previousWindow: input.windows.previous,
    buckets: input.project.buckets, databases: input.project.d1Databases, objectMethods: input.objectMethods, workerBilling: input.project.workerBilling
  });
  const lines = ledger.lines.map(line => reportLine(line, null, input));
  const residuals = lines.flatMap(line => line.children.filter(child => child.kind === "unrouted")).map((line): Residual => ({ lineId: line.id, label: line.label, monthly: monthlyOf(line) ?? { now: 0, before: null } }));
  const meters = metersOf(lines, input);
  const plan = planBillReport(input, monthlyUsage(ledger));
  const confidence = totalConfidence(lines);
  return {
    generatedAtMs: input.nowMs,
    pricingRevision: PRICING_REVISION,
    project: { id: input.project.id, worker: input.project.worker },
    windows: input.windows,
    units: UNITS,
    total: {
      basis: "list-price-run-rate", monthly: ledger.monthly, pricedMeters: meters.priced, excluded: meters.excluded, residuals,
      uncompared: ledger.uncompared, confidence: missingMeters(input.current, input.windows.current, input.project).length > 0 && confidence === "verified" ? "qualified" : confidence
    },
    comparison: { baseline: ledger.monthly.before === null ? "absent" : "present", change: ledger.monthly.before === null ? null : ledger.monthly.now - ledger.monthly.before },
    lines,
    ranking: ranking(lines),
    planBill: plan,
    warnings: warningsFor(input, lines, residuals, plan)
  };
}
