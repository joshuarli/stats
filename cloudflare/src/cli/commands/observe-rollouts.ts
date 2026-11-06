import { decodeDeploymentHistory } from "../../deployments/decode.ts";
import { decodeImpact } from "../../observe/client/decode.ts";
import { routeShift } from "../../observe/client/impact.ts";
import type { IssueRef, RolloutImpact } from "../../observe/core/store.ts";
import { isObservedService, OBSERVED_SERVICES } from "../../observe/services.ts";
import { decodeProjects } from "../decode.ts";
import type { Warning, Window } from "../envelope.ts";
import { CommandError, EXIT, transportError, usageError } from "../exit.ts";
import { defineCommand, type CommandContext } from "../registry.ts";
import { table, timeText } from "../text.ts";
import { read } from "./observe.ts";
import { TEXT_ROWS } from "./deployments.ts";

const DURATION = /^([1-9][0-9]{0,3})(m|h|d)$/u;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const DEFAULT_SETTLE = "3h";
const DEFAULT_WITHIN = "24h";

export interface IssueChange {
  readonly kind: "new-issue" | "regression";
  readonly fingerprint: string;
  readonly name: string;
  readonly operation: string | null;
  readonly frame: string | null;
  readonly occurrences: number;
}

export interface CpuChange {
  readonly kind: "cpu";
  readonly stage: string;
  readonly route: string;
  readonly beforeMs: number;
  readonly afterMs: number;
  readonly changeMs: number;
  readonly twoStdErrMs: number;
  readonly beforeRequests: number;
  readonly afterRequests: number;
}

export interface FailureRateChange {
  readonly kind: "failure-rate";
  readonly before: { readonly requests: number; readonly failed: number; readonly rate: number };
  readonly after: { readonly requests: number; readonly failed: number; readonly rate: number };
  readonly change: number;
  readonly twoStdErr: number;
}

export type Change = IssueChange | CpuChange | FailureRateChange;

export interface RolloutFinding {
  readonly rolloutId: string;
  readonly service: string;
  readonly atMs: number;
  readonly versions: readonly { readonly id: string; readonly label: string | null }[];
  readonly changes: readonly Change[];
  readonly drillIn: readonly string[];
}

export interface RolloutsPayload {
  readonly settle: string;
  readonly within: string;
  readonly startedFromMs: number;
  readonly startedToMs: number;
  readonly checked: readonly { readonly service: string; readonly rollouts: number }[];
  readonly findings: readonly RolloutFinding[];
}

function duration(context: CommandContext, name: string, fallback: string): { readonly text: string; readonly ms: number } {
  const text = context.option(name) ?? fallback;
  const match = DURATION.exec(text);
  if (match === null) throw usageError(`--${name} must be a number of minutes, hours, or days such as 90m, 3h, or 2d`);
  return { text, ms: Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS] };
}

function issueChange(kind: IssueChange["kind"], issue: IssueRef): IssueChange {
  return { kind, fingerprint: issue.fingerprint, name: issue.name, operation: issue.operation, frame: issue.frame, occurrences: issue.occurrences };
}

function failureRateChange(impact: RolloutImpact): FailureRateChange | undefined {
  const side = (introduced: boolean) => {
    const rows = impact.versions.filter(version => version.introduced === introduced);
    const requests = rows.reduce((sum, row) => sum + row.requests, 0);
    const failed = rows.reduce((sum, row) => sum + row.failed, 0);
    return { requests, failed, rate: requests === 0 ? 0 : failed / requests };
  };
  const before = side(false);
  const after = side(true);
  if (before.requests === 0 || after.requests === 0) return undefined;
  const twoStdErr = 2 * Math.sqrt((before.rate * (1 - before.rate)) / before.requests + (after.rate * (1 - after.rate)) / after.requests);
  const change = after.rate - before.rate;
  return Math.abs(change) > twoStdErr ? { kind: "failure-rate", before, after, change, twoStdErr } : undefined;
}

export function changesOf(impact: RolloutImpact): Change[] {
  if (impact.state !== "measured") return [];
  const cpu = impact.routes.map(route => routeShift(route, impact.introduced)).flatMap((shift): CpuChange[] => shift.exceedsTwoStdErr
    ? [{ kind: "cpu", stage: shift.stage, route: shift.label, beforeMs: shift.before!.cpuMeanMs, afterMs: shift.after!.cpuMeanMs, changeMs: shift.cpuChangeMs!, twoStdErrMs: shift.twoStdErrMs!, beforeRequests: shift.before!.requests, afterRequests: shift.after!.requests }]
    : []);
  const failure = failureRateChange(impact);
  return [...impact.newIssues.map(issue => issueChange("new-issue", issue)), ...impact.regressions.map(issue => issueChange("regression", issue)), ...(failure === undefined ? [] : [failure]), ...cpu];
}

function drillIn(service: string, impact: RolloutImpact): string[] {
  return [
    `statsctl observe deployment --project ${service} --deployment ${impact.rolloutId} --json`,
    ...impact.introduced.map(version => `statsctl observe issues --project ${service} --introduced-in ${version} --json`)
  ];
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

function signed(value: number, digits: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function changeText(change: Change): string {
  switch (change.kind) {
    case "new-issue":
    case "regression": {
      const label = change.kind === "new-issue" ? "new issue" : "regression";
      return `${label}: ${change.name}${change.operation === null ? "" : ` [${change.operation}]`}${change.frame === null ? "" : ` ${change.frame}`} (${change.occurrences} occurrences)`;
    }
    case "cpu":
      return `cpu ${change.stage} ${change.route}: ${change.beforeMs.toFixed(2)} -> ${change.afterMs.toFixed(2)} ms (${signed(change.changeMs, 2)}, spread +-${change.twoStdErrMs.toFixed(2)}; ${change.beforeRequests} -> ${change.afterRequests} calls)`;
    case "failure-rate":
      return `failure rate: ${percent(change.before.rate)} of ${change.before.requests} -> ${percent(change.after.rate)} of ${change.after.requests} (${signed(change.change * 100, 2)} points, spread +-${(change.twoStdErr * 100).toFixed(2)})`;
  }
}

export const observeRolloutsCommand = defineCommand<RolloutsPayload>({
  name: "observe rollouts",
  summary: "report settled rollouts that brought new issues, regressions, or changes beyond spread",
  description: [
    "For each rollout of an observed service that started between --within and --settle ago, reads the same impact report as `observe deployment` and reports it only when it has a new issue group, a regression, or a failure-rate or per-route CPU change larger than twice its combined standard error (the rule `observe deployment` marks as beyond noise).",
    "Without --project, checks every observed service whose project has deployment history. Read-only and stateless: a rollout that still has findings is reported again on every run until it ages past --within, so --within bounds the repetition.",
    "Exit 0 when nothing is reported, 8 when there are findings, and the usual 2, 3, and 4 for usage, authentication, and transport or contract failures. It reports and proposes; it never pushes or deploys."
  ],
  access: "read",
  options: {
    project: { type: "string", placeholder: "SERVICE", description: `one observed service: ${OBSERVED_SERVICES.join(", ")} (default: every observed service with deployment history)` },
    settle: { type: "string", placeholder: "SPAN", default: DEFAULT_SETTLE, description: "minimum rollout age before it is checked, such as 90m, 3h, or 1d" },
    within: { type: "string", placeholder: "SPAN", default: DEFAULT_WITHIN, description: "maximum rollout age; older rollouts are not checked" }
  },
  examples: ["statsctl observe rollouts --json", "statsctl observe rollouts --project stats --settle 3h --within 24h --json"],
  limitations: [
    "Observe retention is 7 days; a rollout older than that is skipped.",
    "A failure-rate or CPU change is reported in either direction, labelled by its sign.",
    "The failure-rate spread is twice the standard error of the difference of two proportions, the same twice-standard-error rule as CPU; `observe deployment` reports no failure-rate spread of its own.",
    "Findings come from the impact report alone; run the drill-in commands for the issue lists and routes."
  ],
  async run(context) {
    const requested = context.option("project");
    if (requested !== undefined && !isObservedService(requested)) throw new CommandError(EXIT.usage, "not_observed", `only ${OBSERVED_SERVICES.join(", ")} are observed, not ${requested}`);
    const settle = duration(context, "settle", DEFAULT_SETTLE);
    const within = duration(context, "within", DEFAULT_WITHIN);
    if (settle.ms >= within.ms) throw usageError("--settle must be shorter than --within");
    const nowMs = context.now();
    const startedFromMs = nowMs - within.ms;
    const startedToMs = nowMs - settle.ms;

    const listed = await context.http.getJson("/api/v1/projects", decodeProjects);
    if (listed.kind !== "ok") throw transportError("contract", "/api/v1/projects answered not-modified to an unconditional request");
    const projects = listed.value.filter(project => isObservedService(project.worker) && (requested === undefined || project.worker === requested));
    if (requested !== undefined && projects.length === 0) throw new CommandError(EXIT.usage, "no_project", `no project runs the worker ${requested}`);

    const warnings: Warning[] = [];
    const checked: { service: string; rollouts: number }[] = [];
    const findings: RolloutFinding[] = [];
    const rolloutIds: string[] = [];
    for (const project of projects) {
      const service = project.worker;
      const path = `/api/v1/projects/${encodeURIComponent(project.id)}/deployments`;
      const history = await context.http.getJson(path, value => decodeDeploymentHistory(value, project.id));
      if (history.kind !== "ok") throw transportError("contract", `${path} answered not-modified to an unconditional request`);
      if (!history.value.enabled) {
        warnings.push({ code: "deployments_not_enabled", message: `${service} has no deployment history, so its rollouts are not checked` });
        continue;
      }
      const due = history.value.deployments.filter(deployment => deployment.atMs >= startedFromMs && deployment.atMs <= startedToMs).sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id));
      checked.push({ service, rollouts: due.length });
      for (const deployment of due) {
        const impact = await read(context, service, `/rollouts/${encodeURIComponent(deployment.id)}/impact`, value => decodeImpact(value, deployment.id));
        rolloutIds.push(impact.rolloutId);
        if (impact.state === "expired") {
          warnings.push({ code: "rollout_expired", message: `rollout ${impact.rolloutId} of ${service} is older than retained data and was not checked` });
          continue;
        }
        const changes = changesOf(impact);
        if (changes.length === 0) continue;
        findings.push({
          rolloutId: impact.rolloutId, service, atMs: impact.atMs,
          versions: impact.versions.filter(version => version.introduced).map(version => ({ id: version.version, label: version.label })),
          changes, drillIn: drillIn(service, impact)
        });
      }
    }
    const window: Window = { fromMs: startedFromMs, toMs: startedToMs };
    return {
      ...(requested === undefined ? {} : { project: requested }),
      windows: [window],
      warnings,
      identities: { deploymentIds: rolloutIds, versionIds: [...new Set(findings.flatMap(finding => finding.versions.map(version => version.id)))] },
      payload: { settle: settle.text, within: within.text, startedFromMs, startedToMs, checked, findings },
      exit: findings.length === 0 ? EXIT.ok : EXIT.findings
    };
  },
  render({ settle, within, startedFromMs, startedToMs, checked, findings }) {
    const total = checked.reduce((sum, item) => sum + item.rollouts, 0);
    const lines = [`observe rollouts started [${timeText(startedFromMs)}, ${timeText(startedToMs)}) (within ${within}, settled ${settle}): ${total} checked, ${findings.length} with findings`];
    if (findings.length === 0) return [...lines, "nothing to report"];
    for (const finding of findings) {
      const versions = finding.versions.map(version => version.label ?? version.id).join(", ");
      lines.push("", `${finding.service} rollout ${finding.rolloutId} at ${timeText(finding.atMs)}${versions === "" ? "" : ` (${versions})`}`);
      lines.push(...finding.changes.slice(0, TEXT_ROWS).map(change => `  ${changeText(change)}`));
      if (finding.changes.length > TEXT_ROWS) lines.push(`  ${finding.changes.length - TEXT_ROWS} more changes omitted; use --json`);
      lines.push(...table(finding.drillIn.map(command => ["  drill in", command])));
    }
    return lines;
  }
});
