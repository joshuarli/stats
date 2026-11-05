import { PRICING_REVISION } from "../../cost/pricing.ts";
import type { CostReport } from "../../cost/report.ts";
import { decodeProjects, type ProjectSummary } from "../decode.ts";
import { ledgerOf, loadCostInputs, resolveLive } from "../cost-load.ts";
import { presentReport, type PresentedLine, type PresentedReport } from "../cost-payload.ts";
import type { Warning } from "../envelope.ts";
import { CommandError, EXIT, transportError, usageError } from "../exit.ts";
import { MEASUREMENT_REVISION } from "../revisions.ts";
import { defineCommand, type CommandContext, type OptionSpecs } from "../registry.ts";
import { parseSnapshot, type CostInputs } from "../snapshot-format.ts";
import { readSnapshotFile } from "../snapshot-store.ts";
import { table, timeText } from "../text.ts";
import { parseWindowRequest } from "../windows.ts";

export interface Failure {
  readonly code: string;
  readonly message: string;
}

export type ProjectCost =
  | { readonly id: string; readonly status: "ok"; readonly requests: number; readonly report: PresentedReport }
  | { readonly id: string; readonly status: "unavailable"; readonly requests: number; readonly error: Failure };

export interface CostPayload {
  readonly requests: { readonly shared: number; readonly total: number };
  readonly projects: readonly ProjectCost[];
}

export const windowOption: OptionSpecs = {
  window: { type: "string", placeholder: "SPAN", default: "latest settled hour", description: "trailing window ending at the last settled bucket, one of 1h, 6h, 24h, 7d, 30d; UTC, half-open [from, to)" }
};

export async function listProjects(context: CommandContext): Promise<readonly ProjectSummary[]> {
  const fetched = await context.http.getJson("/api/v1/projects", decodeProjects);
  if (fetched.kind !== "ok") throw transportError("contract", "/api/v1/projects answered not-modified to an unconditional request");
  return fetched.value;
}

export function selectProject(projects: readonly ProjectSummary[], id: string): ProjectSummary {
  const found = projects.find(candidate => candidate.id === id);
  if (found === undefined) throw usageError(`unknown project ${id}; known: ${projects.map(candidate => candidate.id).join(", ")}`);
  return found;
}

export function reportOf(inputs: CostInputs): CostReport {
  try {
    return ledgerOf(inputs).report;
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw transportError("malformed_frame", `the history frame of ${inputs.project.id} is invalid: ${error instanceof Error ? error.message : "invalid"}`);
  }
}

function entryOf(inputs: CostInputs, series: boolean): ProjectCost {
  const report = reportOf(inputs);
  return { id: inputs.project.id, status: "ok", requests: inputs.requests.project, report: presentReport(report, series) };
}

function walk(lines: readonly PresentedLine[]): PresentedLine[] {
  return lines.flatMap(line => [line, ...walk(line.children)]);
}

const dollars = (amount: number): string => `$${amount.toFixed(amount < 1 ? 4 : 2)}`;

function window(report: PresentedReport): string {
  return `${timeText(report.windows.current.fromMs)} to ${timeText(report.windows.current.toMs)}`;
}

function describe(entry: ProjectCost): string[] {
  if (entry.status === "unavailable") return [`${entry.id}: unavailable ${entry.error.code}: ${entry.error.message}`];
  const { report } = entry;
  const lines = walk(report.lines);
  const total = report.total.monthly;
  const baseline = total.before === null ? "no baseline" : `baseline ${dollars(total.before)}`;
  const rows = report.ranking.byCost.slice(0, 10).map(rank => {
    const line = lines.find(candidate => candidate.id === rank.id);
    return [rank.id, `${dollars(rank.monthly)}/month`, rank.change === null ? "no baseline" : `${rank.change >= 0 ? "+" : "-"}${dollars(Math.abs(rank.change))}`, line?.confidence ?? "unknown"];
  });
  return [
    `${entry.id}: ${dollars(total.now)}/month list-price run rate (${report.total.confidence}), ${baseline}`,
    `  window ${window(report)} (utc, half-open); ${entry.requests} requests`,
    ...(rows.length === 0 ? ["  no priced line"] : table(rows).map(row => `  ${row}`)),
    ...(report.warnings.length === 0 ? [] : [`  ${report.warnings.length} warnings; run with --json for the list`])
  ];
}

export function renderCost(payload: CostPayload): string[] {
  if (payload.projects.length === 0) return ["no projects configured"];
  return [`cost, pricing revision ${PRICING_REVISION}; ${payload.requests.total} requests (${payload.requests.shared} shared)`, ...payload.projects.flatMap(describe)];
}

export function metaOf(entries: readonly ProjectCost[], notes: readonly (readonly [string, Warning])[], prefixed: boolean) {
  const ok = entries.flatMap(entry => entry.status === "ok" ? [entry] : []);
  const first = ok[0]?.report;
  const tag = (id: string) => prefixed ? `${id}: ` : "";
  const failed = entries.flatMap(entry => entry.status === "unavailable" ? [{ code: entry.error.code, message: `${tag(entry.id)}unavailable: ${entry.error.message}` }] : []);
  const coverage: Record<string, string> = {};
  for (const entry of ok) {
    const worker = entry.report.lines.find(line => line.id === "worker");
    coverage[entry.id] = `${entry.report.total.confidence}; worker ${Math.round((worker?.coverage.fraction ?? 0) * 100)}% of the window`;
  }
  const names = (select: (entry: typeof ok[number]) => readonly string[]) => ok.flatMap(entry => select(entry).map(name => `${entry.id}:${name}`)).sort();
  return {
    ...(first === undefined ? {} : { windows: [first.windows.current, first.windows.previous], units: Object.fromEntries(Object.entries(first.units).map(([key, value]) => [key, String(value)])) }),
    pricingRevision: PRICING_REVISION,
    measurementRevision: MEASUREMENT_REVISION,
    coverage,
    priced: names(entry => entry.report.total.pricedMeters),
    excluded: names(entry => entry.report.total.excluded.map(item => `${item.meter} (${item.reason})`)),
    warnings: [
      ...failed,
      ...notes.map(([id, note]): Warning => ({ code: note.code, message: `${tag(id)}${note.message}` })),
      ...ok.flatMap(entry => entry.report.warnings.map((warning): Warning => ({ code: warning.code, message: `${tag(entry.id)}${warning.subject}: ${warning.message}` })))
    ]
  };
}

function replay(context: CommandContext, file: string, series: boolean) {
  const rejected = ["window", "from", "to"].filter(name => context.option(name) !== undefined);
  if (context.flag("month-to-date")) rejected.push("month-to-date");
  if (rejected.length > 0) throw usageError(`--input replays the windows saved in the snapshot; remove ${rejected.map(name => `--${name}`).join(", ")}`);
  const inputs = parseSnapshot(readSnapshotFile(file));
  const requested = context.option("project");
  if (requested !== undefined && requested !== inputs.project.id) throw usageError(`the snapshot is for project ${inputs.project.id}, not ${requested}`);
  const entry = entryOf(inputs, series);
  const projects = [entry];
  return {
    project: inputs.project.id,
    payload: { requests: { shared: inputs.requests.shared, total: inputs.requests.shared + inputs.requests.project }, projects } satisfies CostPayload,
    ...metaOf(projects, inputs.notes.map(note => [inputs.project.id, note] as const), false)
  };
}

export const costCommand = defineCommand<CostPayload>({
  name: "cost",
  summary: "price one project's resource use over a window and find the bottleneck",
  description: [
    "Builds the same cost report as the dashboard from the authenticated history routes, priced from a versioned tariff table.",
    "The default window is the latest settled hour: the settled boundary comes from the worker history, exactly as the dashboard computes it, never the newest incomplete bucket. The report compares it with the window of equal length before it.",
    "Totals list their priced meters, excluded meters, and residuals. Missing data is `uncollected`, never zero.",
    "Large series are omitted unless --series is set; each line shows its top 15 children and the cost of the rest.",
    "--month-to-date prices the UTC calendar month so far, up to the last settled bucket, and adds the isolated plan bill. It is not the billing cycle.",
    "Requests: the project list and the settle probe are shared by every project; each project then makes at most 4 (current history, previous history, and for an observed project with Durable Objects the method statistics of both windows).",
    "--all reports every project in one document. A project that fails is marked unavailable and the others are still reported."
  ],
  access: "read",
  options: {
    project: { type: "string", placeholder: "ID", description: "project id from `statsctl projects`" },
    all: { type: "boolean", description: "report every project; exclusive with --project" },
    ...windowOption,
    from: { type: "string", placeholder: "MS", description: "window start, epoch milliseconds UTC (inclusive); needs --to" },
    to: { type: "string", placeholder: "MS", description: "window end, epoch milliseconds UTC (exclusive); needs --from" },
    "month-to-date": { type: "boolean", description: "UTC calendar month so far; not the billing cycle" },
    input: { type: "string", placeholder: "FILE", description: "price a saved snapshot offline instead of reading the origin; makes no request and runs no credential command" },
    series: { type: "boolean", description: "include full series" }
  },
  exclusive: [["project", "all"], ["window", "from", "month-to-date"], ["input", "all"]],
  together: [["from", "to"]],
  examples: ["statsctl cost --project stats --window 1h --json", "statsctl cost --all --window 24h --json", "statsctl cost --project stats --input .work/statsctl/snapshots/stats.json --json"],
  limitations: [
    "A lower monthly estimate is not evidence that a change helped; use `verify` for that.",
    "A window may span at most 30 days, so --month-to-date fails on the last day of a 31-day month.",
    "Replaying a snapshot refuses a different schema, pricing revision, measurement revision, or hash with exit 4."
  ],
  async run(context) {
    const series = context.flag("series");
    const file = context.option("input");
    if (file !== undefined) return replay(context, file, series);
    const id = context.option("project");
    const all = context.flag("all");
    if (id === undefined && !all) throw usageError("give --project ID, --all, or --input FILE");
    const request = parseWindowRequest({ window: context.option("window"), from: context.option("from"), to: context.option("to"), monthToDate: context.flag("month-to-date") });
    const capturedAtMs = context.now();
    const projects = await listProjects(context);
    const selected = all ? projects : [selectProject(projects, id ?? "")];
    const probe = selected[0];
    if (probe === undefined) return { payload: { requests: { shared: context.http.requests(), total: context.http.requests() }, projects: [] } };
    const windows = await resolveLive(context, probe.id, request);
    const shared = context.http.requests();
    const entries: ProjectCost[] = [];
    const notes: (readonly [string, Warning])[] = [];
    for (const project of selected) {
      const before = context.http.requests();
      try {
        const inputs = await loadCostInputs(context, project, windows, capturedAtMs, shared);
        notes.push(...inputs.notes.map(note => [project.id, note] as const));
        entries.push(entryOf(inputs, series));
      } catch (error) {
        if (!all || !(error instanceof CommandError) || error.exit === EXIT.auth) throw error;
        entries.push({ id: project.id, status: "unavailable", requests: context.http.requests() - before, error: { code: error.code, message: error.message } });
      }
    }
    const unavailable = entries.length > 0 && entries.every(entry => entry.status === "unavailable");
    return {
      ...(all ? {} : { project: selected[0]?.id ?? "" }),
      payload: { requests: { shared, total: context.http.requests() }, projects: entries },
      ...(unavailable ? { exit: EXIT.transport } : {}),
      ...metaOf(entries, notes, all)
    };
  },
  render: renderCost
});
