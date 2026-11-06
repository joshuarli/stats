import { decodeExploration, decodeImpact, decodeIssues, decodeStatsWindow, decodeTraces } from "../../observe/client/decode.ts";
import type { Exploration, IssueSummary, LagTotals, Page, RolloutImpact, RouteStats, StatsWindow, TracePage } from "../../observe/core/store.ts";
import { OPERATION_BUCKET_MS } from "../../observe/core/limits.ts";
import { POLICIES } from "../../observe/core/policies.ts";
import { observeWindowPath } from "../verify/gather.ts";
import { VERSION, type Stage } from "../../observe/core/model.ts";
import type { SamplingSummary } from "../../observe/core/counts.ts";
import { isObservedService, OBSERVED_SERVICES, type ObservedService } from "../../observe/services.ts";
import type { Window } from "../envelope.ts";
import { CommandError, EXIT, transportError, usageError } from "../exit.ts";
import { defineCommand, type CommandContext, type OptionSpec } from "../registry.ts";
import { table, timeText } from "../text.ts";
import { TEXT_ROWS } from "./deployments.ts";

const WINDOWS: Readonly<Record<string, number>> = { "1h": 3_600_000, "6h": 21_600_000, "24h": 86_400_000, "7d": 604_800_000 };
const ISSUE_STATES = ["open", "resolved"];

const project: OptionSpec = { type: "string", placeholder: "ID", required: true, description: `an observed service: ${OBSERVED_SERVICES.join(", ")}` };
const window: OptionSpec = { type: "string", placeholder: "SPAN", default: "24h", description: "trailing window, one of 1h, 6h, 24h, 7d; UTC, half-open [from, to)" };

function observedProject(context: CommandContext): ObservedService {
  const value = context.option("project");
  if (value === undefined) throw usageError("missing required option --project");
  if (!isObservedService(value)) throw new CommandError(EXIT.usage, "not_observed", `only ${OBSERVED_SERVICES.join(", ")} are observed, not ${value}`);
  return value;
}

function trailingWindow(context: CommandContext): Window & { readonly span: string } {
  const span = context.option("window") ?? "24h";
  const length = WINDOWS[span];
  if (length === undefined) throw usageError("--window must be 1h, 6h, 24h, or 7d");
  const toMs = context.now();
  return { fromMs: toMs - length, toMs, span };
}

export async function read<T>(context: CommandContext, service: string, path: string, decode: (value: unknown) => T): Promise<T> {
  const fetched = await context.http.getJson(`/api/observe/${service}${path}`, decode);
  if (fetched.kind !== "ok") throw transportError("contract", `${path} answered not-modified to an unconditional request`);
  return fetched.value;
}

function sampledMs(value: number | null): string {
  return value === null ? "sampled out" : ms(value);
}

function ms(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value} ms`;
}

function samplingNote(sampling: SamplingSummary | undefined, what: string): string[] {
  if (sampling === undefined) return [];
  const share = sampling.observed === 0 ? "none" : `${((sampling.kept / sampling.observed) * 100).toFixed(2)}%`;
  return [`sampled: ${what} come from ${sampling.kept} kept of ${sampling.observed} observed invocations (${share}; keep rate ${sampling.keepPerMillion} per million). Counts of observed invocations are exact.`];
}

function omitted(total: number): string[] {
  return total > TEXT_ROWS ? [`${total - TEXT_ROWS} more rows omitted; use --json`] : [];
}

export interface RoutesPayload {
  readonly span: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly routes: readonly RouteStats[];
  readonly sampling?: SamplingSummary;
}

export const observeRoutesCommand = defineCommand<RoutesPayload>({
  name: "observe routes",
  summary: "rank routes by CPU with latency percentiles over a window",
  description: ["Reads the observe service for the stats project. Read-only."],
  access: "read",
  options: { project, window },
  examples: ["statsctl observe routes --project stats --window 1h --json"],
  limitations: [
    "Observe retention is 7 days.",
    `Text shows the top ${TEXT_ROWS} routes by CPU.`,
    "For a sampled service the payload carries `sampling`; its percentiles, requests, failed and cpu come from the kept invocations only, and `observed` is the exact count."
  ],
  async run(context) {
    const name = observedProject(context);
    const { fromMs, toMs, span } = trailingWindow(context);
    const exploration: Exploration = await read(context, name, `/explore?${new URLSearchParams({ from: String(fromMs), to: String(toMs) })}`, decodeExploration);
    const routes = [...exploration.routes].sort((a, b) => b.cpuMs - a.cpuMs);
    return { project: name, windows: [{ fromMs, toMs }], payload: { span, fromMs, toMs, routes, ...(exploration.sampling === undefined ? {} : { sampling: exploration.sampling }) } };
  },
  render({ span, fromMs, toMs, routes, sampling }) {
    const lines = [`observe routes, last ${span}: [${timeText(fromMs)}, ${timeText(toMs)})`];
    if (routes.length === 0) return [...lines, "no routes retained in this window", ...samplingNote(sampling, "kept counts")];
    const total = Math.max(1, routes.reduce((sum, route) => sum + route.cpuMs, 0));
    const percentiles = sampling === undefined ? ["p50", "p95", "p99", "p95 cpu"] : ["p50 (sampled)", "p95 (sampled)", "p99 (sampled)", "p95 cpu (sampled)"];
    const head = sampling === undefined ? ["route", "requests", "failed", "cpu", ...percentiles] : ["route", "kept", "observed", "failed", "cpu", ...percentiles];
    const row = (route: RouteStats) => [
      route.label, String(route.requests), ...(sampling === undefined ? [] : [String(route.observed ?? 0)]), String(route.failed), `${Math.round((route.cpuMs / total) * 100)}%`,
      sampledMs(route.p50WallMs), sampledMs(route.p95WallMs), sampledMs(route.p99WallMs), sampledMs(route.p95CpuMs)
    ];
    return [...lines, ...samplingNote(sampling, "the kept, failed, cpu and percentile columns"), ...table([head, ...routes.slice(0, TEXT_ROWS).map(row)]), ...omitted(routes.length)];
  }
});

export interface TracesPayload {
  readonly span: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly traces: TracePage;
}

export const observeTracesCommand = defineCommand<TracesPayload>({
  name: "observe traces",
  summary: "list recent traces, slowest or failed first",
  description: ["Reads trace summaries from the observe service. Read-only."],
  access: "read",
  options: {
    project,
    window,
    route: { type: "string", placeholder: "LABEL", description: "only this route label" },
    failed: { type: "boolean", description: "only failed invocations" }
  },
  examples: ["statsctl observe traces --project stats --window 1h --failed --json"],
  limitations: [
    "Resolving, reopening, and source-map registration are not exposed; use `pnpm observe`.",
    `Reads one page of at most ${TEXT_ROWS} traces; --json carries the next cursor.`,
    "For a sampled service only kept invocations are listed, and `traces.sampling` says how many were observed."
  ],
  async run(context) {
    const name = observedProject(context);
    const { fromMs, toMs, span } = trailingWindow(context);
    const query = new URLSearchParams({ from: String(fromMs), to: String(toMs), limit: String(TEXT_ROWS), order: "slowest" });
    const route = context.option("route");
    if (route !== undefined) query.set("label", route);
    if (context.flag("failed")) query.set("failed", "true");
    const traces = await read(context, name, `/traces?${query}`, decodeTraces);
    return { project: name, windows: [{ fromMs, toMs }], identities: { versionIds: [...new Set(traces.items.flatMap(item => item.version === null ? [] : [item.version]))] }, payload: { span, fromMs, toMs, traces } };
  },
  render({ span, fromMs, toMs, traces }) {
    const lines = [`observe traces, last ${span}: [${timeText(fromMs)}, ${timeText(toMs)}), slowest first`, ...samplingNote(traces.sampling, "the listed traces")];
    if (traces.items.length === 0) return [...lines, "no traces match"];
    return [...lines, ...table([
      ["trace", "route", "status", "wall", "cpu", "at"],
      ...traces.items.slice(0, TEXT_ROWS).map(trace => [trace.traceId ?? "-", trace.label, trace.status === null ? trace.outcome : String(trace.status), ms(trace.wallMs), ms(trace.cpuMs + trace.objectCpuMs), timeText(trace.atMs)])
    ]), ...(traces.next === null ? [] : ["more traces exist; use --json for the cursor"])];
  }
});

export interface IssuesPayload {
  readonly issues: Page<IssueSummary>;
}

export const observeIssuesCommand = defineCommand<IssuesPayload>({
  name: "observe issues",
  summary: "list observed error groups",
  description: ["Reads issue groups from the observe service. Read-only."],
  access: "read",
  options: {
    project,
    state: { type: "string", placeholder: "STATE", default: "open", description: "open or resolved" },
    "introduced-in": { type: "string", placeholder: "VERSION", description: "only issues first seen in this version" }
  },
  examples: ["statsctl observe issues --project stats --state open --json"],
  limitations: ["Stack frames are never written to snapshots.", `Reads one page of at most ${TEXT_ROWS} issues; --json carries the next cursor.`],
  async run(context) {
    const name = observedProject(context);
    const state = context.option("state") ?? "open";
    if (!ISSUE_STATES.includes(state)) throw usageError("--state must be open or resolved");
    const query = new URLSearchParams({ state, limit: String(TEXT_ROWS) });
    const introducedIn = context.option("introduced-in");
    if (introducedIn !== undefined) {
      if (!VERSION.test(introducedIn)) throw usageError("--introduced-in must be a version id");
      query.set("introducedIn", introducedIn);
    }
    const issues = await read(context, name, `/issues?${query}`, decodeIssues);
    return { project: name, payload: { issues } };
  },
  render({ issues }) {
    if (issues.items.length === 0) return ["no issues match"];
    return [...table([
      ["fingerprint", "issue", "count", "last seen", "since"],
      ...issues.items.slice(0, TEXT_ROWS).map(issue => [issue.fingerprint, `${issue.name}${issue.operation === null ? "" : ` [${issue.operation}]`} ${issue.frame ?? ""}`.trimEnd(), String(issue.occurrences), timeText(issue.lastAtMs), issue.firstVersionLabel ?? issue.firstVersion?.slice(0, 8) ?? "-"])
    ]), ...(issues.next === null ? [] : ["more issues exist; use --json for the cursor"])];
  }
});

export interface DeploymentImpactPayload {
  readonly impact: RolloutImpact;
}

function failureRate(impact: RolloutImpact, introduced: boolean): string {
  const rows = impact.versions.filter(version => version.introduced === introduced);
  const requests = rows.reduce((sum, row) => sum + row.requests, 0);
  return requests === 0 ? "no requests" : `${((rows.reduce((sum, row) => sum + row.failed, 0) / requests) * 100).toFixed(2)}% of ${requests}`;
}

export const observeDeploymentCommand = defineCommand<DeploymentImpactPayload>({
  name: "observe deployment",
  summary: "show new issues and failure rates for one rollout",
  description: ["Reads the observe impact report for one rollout. Read-only."],
  access: "read",
  options: { project, deployment: { type: "string", placeholder: "ID", required: true, description: "rollout or deployment id" } },
  examples: ["statsctl observe deployment --project stats --deployment DEPLOYMENT_ID --json"],
  limitations: [
    "Exploratory: whole-retention scan by version; `verify` does not use it.",
    "For a sampled service request and failed counts are exact, and the per-route CPU comparisons in --json come from kept invocations (`impact.sampling`)."
  ],
  async run(context) {
    const name = observedProject(context);
    const id = context.option("deployment") ?? "";
    if (!VERSION.test(id)) throw usageError("--deployment must be a rollout or deployment id");
    const impact = await read(context, name, `/rollouts/${encodeURIComponent(id)}/impact`, value => decodeImpact(value, id));
    return { project: name, identities: { deploymentIds: [impact.rolloutId], versionIds: impact.introduced }, payload: { impact } };
  },
  render({ impact }) {
    if (impact.state === "expired") return [`rollout ${impact.rolloutId} is older than retained data`];
    const issueLine = (kind: string, issue: RolloutImpact["newIssues"][number]) => `${kind} ${issue.name}${issue.operation === null ? "" : ` [${issue.operation}]`} ${issue.frame ?? ""} (${issue.occurrences})`.trimEnd();
    const changed = [...impact.newIssues.map(issue => issueLine("new       ", issue)), ...impact.regressions.map(issue => issueLine("regressed ", issue))];
    return [
      `rollout ${impact.rolloutId} at ${timeText(impact.atMs)}`,
      `failed requests ${failureRate(impact, false)} -> ${failureRate(impact, true)}`,
      ...samplingNote(impact.sampling, "per-route CPU comparisons"),
      ...(changed.length === 0 ? ["no new or regressed issues"] : changed.slice(0, TEXT_ROWS)),
      ...omitted(changed.length)
    ];
  }
});

export interface SummarizedOperation {
  readonly operation: string;
  readonly workloadClass: string;
  readonly synthetic: boolean;
  readonly count: number;
  readonly failed: number;
  readonly cpuMsSum: number;
  readonly wallMsSum: number;
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly statements: number;
  readonly lag: LagTotals;
}

export interface CountedRows {
  readonly accounted: number;
  readonly read: number;
  readonly written: number;
  readonly statements: number;
}

export interface CountedOperation {
  readonly operation: string | null;
  readonly stage: Stage;
  readonly route: string;
  readonly count: number;
  readonly failed: number;
  readonly cpuMsSum: number;
  readonly wallMsSum: number;
  readonly rows: CountedRows | null;
  readonly workLag: LagTotals | null;
}

interface OperationsWindow {
  readonly span: string;
  readonly fromMs: number;
  readonly toMs: number;
}

export type OperationsPayload = OperationsWindow & (
  | { readonly source: "summaries"; readonly operations: readonly SummarizedOperation[] }
  | { readonly source: "counts"; readonly operations: readonly CountedOperation[] }
);

function byCost<T extends { readonly cpuMsSum: number; readonly count: number }>(key: (row: T) => string) {
  return (a: T, b: T) => b.cpuMsSum - a.cpuMsSum || b.count - a.count || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
}

function summarized(window: StatsWindow): SummarizedOperation[] {
  const totals = new Map<string, { -readonly [K in keyof SummarizedOperation]: SummarizedOperation[K] } & { lag: { count: number; maxMs: number; sumMs: number } }>();
  for (const row of window.operations) {
    const key = [row.operation, row.workloadClass, row.synthetic].join("\u0000");
    const total = totals.get(key) ?? { operation: row.operation, workloadClass: row.workloadClass, synthetic: row.synthetic, count: 0, failed: 0, cpuMsSum: 0, wallMsSum: 0, rowsRead: 0, rowsWritten: 0, statements: 0, lag: { count: 0, maxMs: 0, sumMs: 0 } };
    total.count += row.count;
    total.failed += row.failed;
    total.cpuMsSum += row.cpuMsSum;
    total.wallMsSum += row.wallMsSum;
    total.rowsRead += row.rowsRead;
    total.rowsWritten += row.rowsWritten;
    total.statements += row.statements;
    total.lag.count += row.lagCount;
    total.lag.maxMs = Math.max(total.lag.maxMs, row.lagMsMax);
    total.lag.sumMs += row.lagMsSum;
    totals.set(key, total);
  }
  return [...totals.values()].sort(byCost(row => `${row.operation}\u0000${row.workloadClass}`));
}

function counted(service: ObservedService, counts: NonNullable<StatsWindow["counts"]>): CountedOperation[] {
  const totals = new Map<string, { operation: string | null; stage: Stage; route: string; count: number; failed: number; cpuMsSum: number; wallMsSum: number; rows: { accounted: number; read: number; written: number; statements: number }; workLag: { count: number; maxMs: number; sumMs: number } }>();
  for (const row of counts) {
    const operation = row.operation === "" ? POLICIES[service].labelOperation(row.stage, row.route) : row.operation;
    const key = [row.stage, row.route, operation ?? ""].join("\u0000");
    const total = totals.get(key) ?? { operation, stage: row.stage, route: row.route, count: 0, failed: 0, cpuMsSum: 0, wallMsSum: 0, rows: { accounted: 0, read: 0, written: 0, statements: 0 }, workLag: { count: 0, maxMs: 0, sumMs: 0 } };
    total.count += row.count;
    total.failed += row.failed;
    total.cpuMsSum += row.cpuMsSum;
    total.wallMsSum += row.wallMsSum;
    total.rows.accounted += row.rowAccounts;
    total.rows.read += row.rowsRead;
    total.rows.written += row.rowsWritten;
    total.rows.statements += row.statements;
    total.workLag.count += row.workLagCount;
    total.workLag.maxMs = Math.max(total.workLag.maxMs, row.workLagMsMax);
    total.workLag.sumMs += row.workLagMsSum;
    totals.set(key, total);
  }
  return [...totals.values()]
    .map(({ rows, workLag, ...total }): CountedOperation => ({ ...total, rows: rows.accounted === 0 ? null : rows, workLag: workLag.count === 0 ? null : workLag }))
    .sort(byCost(row => `${row.stage}\u0000${row.route}`));
}

function bucketWindow(context: CommandContext): OperationsWindow {
  const { span, fromMs: trailingFromMs, toMs: nowMs } = trailingWindow(context);
  const toMs = nowMs - (nowMs % OPERATION_BUCKET_MS) + OPERATION_BUCKET_MS;
  return { span, fromMs: toMs - (nowMs - trailingFromMs), toMs };
}

export const observeOperationsCommand = defineCommand<OperationsPayload>({
  name: "observe operations",
  summary: "total each operation's invocations, failures, CPU, wall time, SQLite rows and lag over a window",
  description: [
    "Reads one exact observe window for an observed service and totals it by operation. Read-only.",
    "The window ends at the end of the current five-minute bucket and spans --window before that, so it includes the bucket in progress.",
    "source \"summaries\" (a service that keeps every invocation, such as stats): rows come from the operation summaries each invocation published, by operation, workload class and synthetic flag, with SQLite rows read and written, statements, and ingest lag.",
    "source \"counts\" (a sampled service such as nanoshop-storied): rows come from the exact counts of every kept and sampled-out invocation, by stage and route. operation is the name the invocation's operation summary published, or else the service policy's name for that route (request.<route>, store.rpc.<method>, store.alarm), or null.",
    "rows totals the SQLite rows read and written and the statements of the invocations whose summary carried a row account (rows.accounted of count); null when none did, as for an invocation that has no SQLite storage of its own. workLag totals the work lag the summaries reported (how late the work the invocation ran was, by the producer's own definition): count, maxMs and sumMs; null when none reported one. Neither is ingest lag."
  ],
  access: "read",
  options: { project, window },
  examples: ["statsctl observe operations --project stats --window 1h --json", "statsctl observe operations --project nanoshop-storied --window 1h --json"],
  limitations: [
    "Observe retention is 7 days.",
    "Rows sum every version seen in the window.",
    "A sampled service's counts reach the store when the collector flushes them, within about 20 s of its last event or five minutes on a busy isolate.",
    `Text shows the top ${TEXT_ROWS} rows by CPU.`
  ],
  async run(context) {
    const name = observedProject(context);
    const span = bucketWindow(context);
    const fetched = await context.http.getJson(observeWindowPath(name, span.fromMs, span.toMs), decodeStatsWindow);
    if (fetched.kind !== "ok") throw transportError("contract", "the observe window answered not-modified to an unconditional request");
    const window = fetched.value;
    const versionIds = [...new Set([...window.invocations.map(row => row.version), ...window.operations.map(row => row.version)].filter(version => version !== ""))];
    const meta = { project: name, windows: [{ fromMs: span.fromMs, toMs: span.toMs }], identities: { versionIds } };
    if (window.counts !== undefined) return { ...meta, payload: { ...span, source: "counts", operations: counted(name, window.counts) } };
    const operations = summarized(window);
    const invocations = window.invocations.reduce((sum, row) => sum + row.count, 0);
    const warnings = operations.length === 0 && invocations > 0 ? [{ code: "no_operation_summaries", message: `${invocations} invocations in the window published no operation summary, so ${name} has no per-operation rows` }] : [];
    return { ...meta, warnings, payload: { ...span, source: "summaries", operations } };
  },
  render(payload) {
    const lines = [`observe operations, last ${payload.span}: [${timeText(payload.fromMs)}, ${timeText(payload.toMs)})`];
    if (payload.operations.length === 0) return [...lines, "no operations in this window"];
    if (payload.source === "counts") {
      const rowsText = (row: CountedOperation, value: (rows: CountedRows) => number) => row.rows === null ? "-" : String(value(row.rows));
      return [...lines, "exact counts of every observed invocation; rows and statements sum the invocations that published a row account, - where none did", ...table([
        ["operation", "stage", "route", "count", "failed", "cpu", "wall", "rows read", "rows written", "statements", "work lag max"],
        ...payload.operations.slice(0, TEXT_ROWS).map(row => [
          row.operation ?? "-", row.stage, row.route, String(row.count), String(row.failed), ms(row.cpuMsSum), ms(row.wallMsSum),
          rowsText(row, rows => rows.read), rowsText(row, rows => rows.written), rowsText(row, rows => rows.statements), row.workLag === null ? "-" : ms(row.workLag.maxMs)
        ])
      ]), ...omitted(payload.operations.length)];
    }
    return [...lines, ...table([
      ["operation", "class", "count", "failed", "cpu", "wall", "rows read", "rows written", "statements", "lag max"],
      ...payload.operations.slice(0, TEXT_ROWS).map(row => [`${row.operation}${row.synthetic ? " (synthetic)" : ""}`, row.workloadClass || "-", String(row.count), String(row.failed), ms(row.cpuMsSum), ms(row.wallMsSum), String(row.rowsRead), String(row.rowsWritten), String(row.statements), ms(row.lag.maxMs)])
    ]), ...omitted(payload.operations.length)];
  }
});
