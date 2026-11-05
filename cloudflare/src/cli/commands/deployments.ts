import { COMPARISON_WINDOWS, comparisonBounds, type ComparisonWindow, type WindowBounds } from "../../deployments/compare.ts";
import { decodeDeploymentHistory } from "../../deployments/decode.ts";
import type { Deployment, DeploymentHistory, DeploymentVersion } from "../../deployments/model.ts";
import { transportError, usageError } from "../exit.ts";
import { defineCommand, type CommandContext } from "../registry.ts";
import { table, timeText } from "../text.ts";

export const PROJECT_ID = /^[a-z][a-z0-9-]{0,31}$/u;
export const TEXT_ROWS = 50;

export function requireProject(context: CommandContext): string {
  const project = context.option("project");
  if (project === undefined || !PROJECT_ID.test(project)) throw usageError("--project must be a project id such as stats");
  return project;
}

export async function readDeploymentHistory(context: CommandContext, project: string): Promise<DeploymentHistory> {
  const path = `/api/v1/projects/${encodeURIComponent(project)}/deployments`;
  const fetched = await context.http.getJson(path, value => decodeDeploymentHistory(value, project));
  if (fetched.kind !== "ok") throw transportError("contract", `${path} answered not-modified to an unconditional request`);
  return fetched.value;
}

export function newestFirst(deployments: readonly Deployment[]): Deployment[] {
  return [...deployments].sort((a, b) => b.atMs - a.atMs || a.id.localeCompare(b.id));
}

export interface WindowCleanliness {
  readonly window: ComparisonWindow;
  readonly before: WindowBounds;
  readonly after: WindowBounds;
  readonly overlaps: readonly string[];
  readonly baselineKnown: boolean;
  readonly clean: boolean;
}

export function windowCleanliness(deployment: Deployment, all: readonly Deployment[], window: ComparisonWindow): WindowCleanliness {
  const { before, after } = comparisonBounds(deployment.atMs, window);
  const previous = all.filter(item => item.atMs < deployment.atMs).sort((a, b) => b.atMs - a.atMs)[0];
  const baselineKnown = previous !== undefined && previous.atMs <= before.fromMs;
  const overlaps = newestFirst(all)
    .filter(item => item.id !== deployment.id && item.atMs >= before.fromMs && item.atMs < after.toMs && item.id !== (previous?.atMs === before.fromMs ? previous.id : ""))
    .map(item => item.id);
  return { window, before, after, overlaps, baselineKnown, clean: overlaps.length === 0 && baselineKnown };
}

export interface ListedDeployment {
  readonly id: string;
  readonly atMs: number;
  readonly source: string;
  readonly message: string | null;
  readonly deferred: boolean;
  readonly versions: readonly DeploymentVersion[];
  readonly comparable: readonly WindowCleanliness[];
}

export interface DeploymentsPayload {
  readonly project: string;
  readonly worker: string;
  readonly enabled: boolean;
  readonly sync: {
    readonly lastAttemptAtMs: number;
    readonly lastSuccessAtMs: number | null;
    readonly ageMs: number | null;
    readonly truncated: boolean;
    readonly error: string | null;
  } | null;
  readonly deployments: readonly ListedDeployment[];
}

function windowCell(entry: WindowCleanliness): string {
  if (entry.overlaps.length > 0) return `overlap(${entry.overlaps.length})`;
  return entry.baselineKnown ? "clean" : "no-baseline";
}

export const deploymentsCommand = defineCommand<DeploymentsPayload>({
  name: "deployments",
  summary: "list a project's deployments with their version ids",
  description: [
    "Lists deployments from the server's recorded history, newest first, with versions, source, and sync state.",
    "Each deployment carries, for the 1h, 6h, and 24h comparison windows, whether the windows around it are free of other deployments (clean), overlapped by others (overlap), or lack a known stable baseline (no-baseline).",
    "Only clean windows can give a comparison that is not confounded by another release. Use the ids with `compare` and `verify`."
  ],
  access: "read",
  options: { project: { type: "string", placeholder: "ID", required: true, description: "project id from `statsctl projects`" } },
  examples: ["statsctl deployments --project stats", "statsctl deployments --project stats --json"],
  limitations: [
    `Text output shows the newest ${TEXT_ROWS} deployments; --json carries all of them.`,
    "Cleanliness uses the deployments the server has recorded; if sync is truncated or stale, older or newer deployments may be missing."
  ],
  async run(context) {
    const project = requireProject(context);
    const history = await readDeploymentHistory(context, project);
    const now = context.now();
    const deployments = newestFirst(history.deployments).map((deployment): ListedDeployment => ({
      id: deployment.id,
      atMs: deployment.atMs,
      source: deployment.source,
      message: deployment.message,
      deferred: deployment.deferred,
      versions: deployment.versions,
      comparable: (Object.keys(COMPARISON_WINDOWS) as ComparisonWindow[]).map(window => windowCleanliness(deployment, history.deployments, window))
    }));
    const warnings = [
      ...(history.enabled ? [] : [{ code: "deployments_not_enabled", message: "deployment history is not enabled for this project" }]),
      ...(history.sync?.truncated === true ? [{ code: "history_truncated", message: "the deployment list was truncated, so older deployments are missing" }] : []),
      ...(history.sync?.error != null ? [{ code: "sync_error", message: history.sync.error }] : [])
    ];
    return {
      project,
      warnings,
      identities: { deploymentIds: deployments.map(item => item.id), versionIds: [...new Set(deployments.flatMap(item => item.versions.map(version => version.id)))] },
      payload: {
        project,
        worker: history.worker,
        enabled: history.enabled,
        sync: history.sync === null ? null : { ...history.sync, ageMs: history.sync.lastSuccessAtMs === null ? null : Math.max(0, now - history.sync.lastSuccessAtMs) },
        deployments
      }
    };
  },
  render({ project, worker, enabled, sync, deployments }) {
    const lines = [`deployments for ${project} (${worker}), deployment history ${enabled ? "enabled" : "not enabled"}`];
    if (sync === null) lines.push("sync: never attempted");
    else lines.push(`sync: last success ${timeText(sync.lastSuccessAtMs)}${sync.ageMs === null ? "" : ` (${Math.round(sync.ageMs / 60_000)} min ago)`}, truncated ${sync.truncated ? "yes" : "no"}, error ${sync.error ?? "none"}`);
    if (deployments.length === 0) return [...lines, "no deployments recorded"];
    const shown = deployments.slice(0, TEXT_ROWS);
    lines.push(...table([
      ["deployment", "time", "source", "deferred", "versions", "1h", "6h", "24h"],
      ...shown.map(item => [
        item.id, timeText(item.atMs), item.source, item.deferred ? "yes" : "no",
        item.versions.map(version => `${version.id}:${version.percentage}%`).join(" "),
        ...item.comparable.map(windowCell)
      ])
    ]));
    if (deployments.length > shown.length) lines.push(`${deployments.length - shown.length} older deployments omitted; use --json for all`);
    lines.push("clean: no other deployment in the before or after window, and a known baseline. Compare with `statsctl compare`; accept with `statsctl verify`.");
    return lines;
  }
});
