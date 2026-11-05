import { decodeDeploymentHistory } from "../../deployments/decode.ts";
import { decodeHealth, decodeStatsWindow, type ObserveHealth } from "../../observe/client/decode.ts";
import type { Warning } from "../envelope.ts";
import { CommandError, EXIT, transportError, usageError } from "../exit.ts";
import { defineCommand, type CommandContext } from "../registry.ts";
import { decodeProjects, type CollectorState, type ProjectSummary } from "../decode.ts";
import { table, timeText } from "../text.ts";
import { readPolicyFile } from "../verify/files.ts";
import { isOperationPolicy } from "../verify/policy.ts";
import { readinessSignals, readinessWindow, type ReadinessSignal, type Source } from "../verify/readiness.ts";
import { observeWindowPath } from "../verify/gather.ts";

export const OBSERVED_PROJECT = "stats";
export const OBSERVE_STALE_MS = 60 * 60 * 1000;
const PROJECT_ID = /^[a-z][a-z0-9-]{0,31}$/u;

export type SectionState = "healthy" | "unhealthy" | "unavailable";

export interface Reason {
  readonly code: string;
  readonly message: string;
}

export interface Section<D> {
  readonly state: SectionState;
  readonly reasons: readonly Reason[];
  readonly data: D | null;
}

export interface DeploymentSyncData {
  readonly enabled: boolean;
  readonly deployments: number;
  readonly sync: {
    readonly lastAttemptAtMs: number;
    readonly lastSuccessAtMs: number | null;
    readonly error: string | null;
    readonly truncated: boolean;
  } | null;
}

export type { ReadinessSignal };

export interface HealthPayload {
  readonly project: string;
  readonly collector: Section<CollectorState>;
  readonly deployments: Section<DeploymentSyncData>;
  readonly observe: Section<ObserveHealth>;
  readonly readiness: { readonly policy: string | null; readonly signals: readonly ReadinessSignal[] };
}

type Read<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: CommandError };

async function attempt<T>(read: () => Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    if (error instanceof CommandError) return { ok: false, error };
    throw error;
  }
}

async function fetchValue<T>(context: CommandContext, path: string, decode: (value: unknown) => T): Promise<T> {
  const fetched = await context.http.getJson(path, decode);
  if (fetched.kind !== "ok") throw transportError("contract", `${path} answered not-modified to an unconditional request`);
  return fetched.value;
}

function asSource<T>(read: Read<T>): Source<T> {
  return read.ok ? read : { ok: false, code: read.error.code, message: read.error.message };
}

function unavailable(error: CommandError): Section<never> {
  return { state: "unavailable", reasons: [{ code: error.code, message: error.message }], data: null };
}

function judge<D>(data: D, reasons: readonly Reason[]): Section<D> {
  return { state: reasons.length === 0 ? "healthy" : "unhealthy", reasons, data };
}

function collectorSection(read: Read<readonly ReturnType<typeof decodeProjects>[number][]>, project: string): Section<CollectorState> {
  if (!read.ok) return unavailable(read.error);
  const entry = read.value.find(candidate => candidate.id === project);
  if (entry === undefined) throw usageError(`unknown project ${project}; known: ${read.value.map(candidate => candidate.id).join(", ")}`);
  const { collector } = entry;
  const reasons: Reason[] = [];
  if (collector.lastSuccessAtMs === null) reasons.push({ code: "collector_never_succeeded", message: "the analytics collector has never completed a run" });
  if (collector.stale) reasons.push({ code: "collector_stale", message: `the last successful collector run was ${timeText(collector.lastSuccessAtMs)}` });
  if (collector.lastError !== null) reasons.push({ code: "collector_error", message: collector.lastError });
  return judge(collector, reasons);
}

function deploymentsSection(read: Read<ReturnType<typeof decodeDeploymentHistory>>): Section<DeploymentSyncData> {
  if (!read.ok) return unavailable(read.error);
  const history = read.value;
  const data: DeploymentSyncData = { enabled: history.enabled, deployments: history.deployments.length, sync: history.sync };
  if (!history.enabled) return { state: "unavailable", reasons: [{ code: "deployments_not_enabled", message: "deployment history is not enabled for this project" }], data };
  const reasons: Reason[] = [];
  if (history.sync === null) reasons.push({ code: "sync_never_attempted", message: "deployment history has never been synced" });
  else {
    if (history.sync.lastSuccessAtMs === null) reasons.push({ code: "sync_never_succeeded", message: "no deployment sync has succeeded" });
    if (history.sync.error !== null) reasons.push({ code: "sync_error", message: history.sync.error });
    if (history.sync.truncated) reasons.push({ code: "history_truncated", message: "the deployment list was truncated, so older deployments are missing" });
  }
  return judge(data, reasons);
}

function observeSection(read: Read<ObserveHealth> | null, now: number): Section<ObserveHealth> {
  if (read === null) return { state: "unavailable", reasons: [{ code: "not_observed", message: `only ${OBSERVED_PROJECT} is observed` }], data: null };
  if (!read.ok) return unavailable(read.error);
  const health = read.value;
  const reasons: Reason[] = [];
  if (health.newestAtMs === null) reasons.push({ code: "no_events", message: "no invocations are retained" });
  else if (now - health.newestAtMs > OBSERVE_STALE_MS) reasons.push({ code: "events_stale", message: `the newest retained invocation is from ${timeText(health.newestAtMs)}` });
  if (health.cleanupBacklog > 0 && health.cleanupLagMs > OBSERVE_STALE_MS) reasons.push({ code: "cleanup_lagging", message: `${health.cleanupBacklog} expired rows are waiting ${Math.round(health.cleanupLagMs / 60_000)} minutes` });
  if (health.evicted > 0) reasons.push({ code: "issues_evicted", message: `${health.evicted} issue groups were evicted at capacity ${health.issueCapacity}` });
  return judge(health, reasons);
}

function describe(name: string, section: Section<unknown>): string[] {
  const lines = [`${name}: ${section.state}`];
  for (const reason of section.reasons) lines.push(`  ${reason.code}: ${reason.message}`);
  return lines;
}

export const healthCommand = defineCommand<HealthPayload>({
  name: "health",
  summary: "judge whether one project's telemetry sources are fresh and complete",
  description: [
    "Reads three independent sections for one project: analytics collector freshness (from the project list), deployment history sync, and observe health.",
    "Each section is healthy, unhealthy, or unavailable, with reason codes. A 200 response alone never makes a section healthy. One failing section does not hide the others.",
    "Only the stats project is observed; for other projects the observe section is unavailable:not_observed.",
    "Authentication failures stop the command with exit 3; if every section that was attempted failed to read, the first failure is the result."
  ],
  access: "read",
  options: {
    project: { type: "string", placeholder: "ID", required: true, description: "project id from `statsctl projects`" },
    policy: { type: "string", placeholder: "FILE", description: "also list each signal this verify policy needs as available or unavailable:<code> under readiness" }
  },
  examples: ["statsctl health --project stats", "statsctl health --project stats --json", "statsctl health --project stats --policy bench/policies/EXPERIMENT.json --json"],
  limitations: [
    "Thresholds are fixed: observe events older than 1 hour are stale.",
    "readiness.signals is empty unless --policy is given; with it the command makes one more request, for the operation window."
  ],
  async run(context) {
    const project = context.option("project");
    if (project === undefined || !PROJECT_ID.test(project)) throw usageError("--project must be a project id such as stats");
    const policyFile = context.option("policy");
    const policy = policyFile === undefined ? null : readPolicyFile(policyFile);
    if (policy !== null && policy.project !== project) throw usageError(`the policy is for project ${policy.project}, not ${project}`);
    const observed = project === OBSERVED_PROJECT;
    const [projects, deployments, observe] = await Promise.all([
      attempt(() => fetchValue(context, "/api/v1/projects", decodeProjects)),
      attempt(() => fetchValue(context, `/api/v1/projects/${encodeURIComponent(project)}/deployments`, value => decodeDeploymentHistory(value, project))),
      observed ? attempt(() => fetchValue(context, `/api/observe/${encodeURIComponent(project)}/health`, decodeHealth)) : Promise.resolve(null)
    ]);
    const attempts = [projects, deployments, ...(observe === null ? [] : [observe])];
    for (const read of attempts) if (!read.ok && read.error.exit === EXIT.auth) throw read.error;
    const failures = attempts.filter(read => !read.ok);
    const first = failures[0];
    if (first !== undefined && !first.ok && failures.length === attempts.length) throw first.error;
    const warnings: Warning[] = failures.flatMap(read => read.ok ? [] : [{ code: read.error.code, message: read.error.message }]);
    const collector = collectorSection(projects, project);
    let readiness: HealthPayload["readiness"] = { policy: null, signals: [] };
    if (policy !== null) {
      const span = readinessWindow(context.now(), policy);
      const window = observed ? await attempt(() => fetchValue(context, observeWindowPath(project, span.fromMs, span.toMs, isOperationPolicy(policy) ? policy.operation : undefined, policy.workloadClass ?? undefined), decodeStatsWindow)) : null;
      const entry = projects.ok ? projects.value.find(candidate => candidate.id === project) : undefined;
      const projectSource: Source<ProjectSummary> = !projects.ok ? asSource(projects) : entry === undefined ? { ok: false, code: "unknown_project", message: `unknown project ${project}` } : { ok: true, value: entry };
      const signals = readinessSignals(policy, {
        nowMs: context.now(),
        project: projectSource,
        observeHealth: observe === null ? null : asSource(observe),
        window: window === null ? null : asSource(window),
        history: asSource(deployments)
      });
      readiness = { policy: policy.id, signals };
    }
    return {
      project,
      warnings,
      payload: {
        project,
        collector,
        deployments: deploymentsSection(deployments),
        observe: observeSection(observe, context.now()),
        readiness
      }
    };
  },
  render({ project, collector, deployments, observe, readiness }) {
    const lines = [`health for ${project}`, ...describe("collector", collector), ...describe("deployments", deployments), ...describe("observe", observe)];
    if (collector.data !== null) lines.push(`collector last success ${timeText(collector.data.lastSuccessAtMs)}`);
    if (deployments.data?.sync) lines.push(`deployment sync last success ${timeText(deployments.data.sync.lastSuccessAtMs)}, ${deployments.data.deployments} deployments`);
    if (observe.data !== null) {
      const { writes } = observe.data;
      lines.push(...table([
        ["observe newest", timeText(observe.data.newestAtMs)],
        ["invocations retained", String(observe.data.liveInvocations)],
        ["rows per invocation", writes.accepted === 0 ? "n/a" : ((writes.ingestRows + writes.cleanupRows) / writes.accepted).toFixed(2)]
      ]));
    }
    if (readiness.signals.length > 0) lines.push(...readiness.signals.map(signal => `readiness ${signal.signal}: ${signal.status} ${signal.message}`));
    return lines;
  }
});
