import { decodeExploration, decodeImpact, decodeIssues, decodeTraces } from "../../observe/client/decode.ts";
import type { Exploration, IssueSummary, Page, RolloutImpact, RouteStats, TraceSummary } from "../../observe/core/store.ts";
import { VERSION } from "../../observe/core/model.ts";
import type { Window } from "../envelope.ts";
import { CommandError, EXIT, transportError, usageError } from "../exit.ts";
import { defineCommand, type CommandContext, type OptionSpec } from "../registry.ts";
import { table, timeText } from "../text.ts";
import { OBSERVED_PROJECT } from "./health.ts";
import { TEXT_ROWS } from "./deployments.ts";

const WINDOWS: Readonly<Record<string, number>> = { "1h": 3_600_000, "6h": 21_600_000, "24h": 86_400_000, "7d": 604_800_000 };
const ISSUE_STATES = ["open", "resolved"];

const project: OptionSpec = { type: "string", placeholder: "ID", required: true, description: "only `stats` is observed" };
const window: OptionSpec = { type: "string", placeholder: "SPAN", default: "24h", description: "trailing window, one of 1h, 6h, 24h, 7d; UTC, half-open [from, to)" };

function observedProject(context: CommandContext): string {
  const value = context.option("project");
  if (value === undefined) throw usageError("missing required option --project");
  if (value !== OBSERVED_PROJECT) throw new CommandError(EXIT.usage, "not_observed", `only ${OBSERVED_PROJECT} is observed, not ${value}`);
  return value;
}

function trailingWindow(context: CommandContext): Window & { readonly span: string } {
  const span = context.option("window") ?? "24h";
  const length = WINDOWS[span];
  if (length === undefined) throw usageError("--window must be 1h, 6h, 24h, or 7d");
  const toMs = context.now();
  return { fromMs: toMs - length, toMs, span };
}

async function read<T>(context: CommandContext, path: string, decode: (value: unknown) => T): Promise<T> {
  const fetched = await context.http.getJson(`/api/observe/${OBSERVED_PROJECT}${path}`, decode);
  if (fetched.kind !== "ok") throw transportError("contract", `${path} answered not-modified to an unconditional request`);
  return fetched.value;
}

function ms(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value} ms`;
}

function omitted(total: number): string[] {
  return total > TEXT_ROWS ? [`${total - TEXT_ROWS} more rows omitted; use --json`] : [];
}

export interface RoutesPayload {
  readonly span: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly routes: readonly RouteStats[];
}

export const observeRoutesCommand = defineCommand<RoutesPayload>({
  name: "observe routes",
  summary: "rank routes by CPU with latency percentiles over a window",
  description: ["Reads the observe service for the stats project. Read-only."],
  access: "read",
  options: { project, window },
  examples: ["statsctl observe routes --project stats --window 1h --json"],
  limitations: ["Observe retention is 7 days.", `Text shows the top ${TEXT_ROWS} routes by CPU.`],
  async run(context) {
    const name = observedProject(context);
    const { fromMs, toMs, span } = trailingWindow(context);
    const exploration: Exploration = await read(context, `/explore?${new URLSearchParams({ from: String(fromMs), to: String(toMs) })}`, decodeExploration);
    const routes = [...exploration.routes].sort((a, b) => b.cpuMs - a.cpuMs);
    return { project: name, windows: [{ fromMs, toMs }], payload: { span, fromMs, toMs, routes } };
  },
  render({ span, fromMs, toMs, routes }) {
    const lines = [`observe routes, last ${span}: [${timeText(fromMs)}, ${timeText(toMs)})`];
    if (routes.length === 0) return [...lines, "no routes retained in this window"];
    const total = Math.max(1, routes.reduce((sum, route) => sum + route.cpuMs, 0));
    return [...lines, ...table([
      ["route", "requests", "failed", "cpu", "p50", "p95", "p99", "p95 cpu"],
      ...routes.slice(0, TEXT_ROWS).map(route => [route.label, String(route.requests), String(route.failed), `${Math.round((route.cpuMs / total) * 100)}%`, ms(route.p50WallMs), ms(route.p95WallMs), ms(route.p99WallMs), ms(route.p95CpuMs)])
    ]), ...omitted(routes.length)];
  }
});

export interface TracesPayload {
  readonly span: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly traces: Page<TraceSummary>;
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
  limitations: ["Resolving, reopening, and source-map registration are not exposed; use `pnpm observe`.", `Reads one page of at most ${TEXT_ROWS} traces; --json carries the next cursor.`],
  async run(context) {
    const name = observedProject(context);
    const { fromMs, toMs, span } = trailingWindow(context);
    const query = new URLSearchParams({ from: String(fromMs), to: String(toMs), limit: String(TEXT_ROWS), order: "slowest" });
    const route = context.option("route");
    if (route !== undefined) query.set("label", route);
    if (context.flag("failed")) query.set("failed", "true");
    const traces = await read(context, `/traces?${query}`, decodeTraces);
    return { project: name, windows: [{ fromMs, toMs }], identities: { versionIds: [...new Set(traces.items.flatMap(item => item.version === null ? [] : [item.version]))] }, payload: { span, fromMs, toMs, traces } };
  },
  render({ span, fromMs, toMs, traces }) {
    const lines = [`observe traces, last ${span}: [${timeText(fromMs)}, ${timeText(toMs)}), slowest first`];
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
    const issues = await read(context, `/issues?${query}`, decodeIssues);
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
  limitations: ["Exploratory: whole-retention scan by version; `verify` does not use it."],
  async run(context) {
    const name = observedProject(context);
    const id = context.option("deployment") ?? "";
    if (!VERSION.test(id)) throw usageError("--deployment must be a rollout or deployment id");
    const impact = await read(context, `/rollouts/${encodeURIComponent(id)}/impact`, value => decodeImpact(value, id));
    return { project: name, identities: { deploymentIds: [impact.rolloutId], versionIds: impact.introduced }, payload: { impact } };
  },
  render({ impact }) {
    if (impact.state === "expired") return [`rollout ${impact.rolloutId} is older than retained data`];
    const issueLine = (kind: string, issue: RolloutImpact["newIssues"][number]) => `${kind} ${issue.name}${issue.operation === null ? "" : ` [${issue.operation}]`} ${issue.frame ?? ""} (${issue.occurrences})`.trimEnd();
    const changed = [...impact.newIssues.map(issue => issueLine("new       ", issue)), ...impact.regressions.map(issue => issueLine("regressed ", issue))];
    return [
      `rollout ${impact.rolloutId} at ${timeText(impact.atMs)}`,
      `failed requests ${failureRate(impact, false)} -> ${failureRate(impact, true)}`,
      ...(changed.length === 0 ? ["no new or regressed issues"] : changed.slice(0, TEXT_ROWS)),
      ...omitted(changed.length)
    ];
  }
});
