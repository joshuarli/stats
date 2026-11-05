import { decodeDeploymentComparison, decodeDeploymentHistory } from "../../deployments/decode.ts";
import { decodeIssues, decodeStatsWindow } from "../../observe/client/decode.ts";
import type { StatsWindow } from "../../observe/core/store.ts";
import { scopeSpec, windowQuery, type ComparisonScope } from "../../compare/spec.ts";
import { transportError } from "../exit.ts";
import { HISTORY_BODY_LIMIT, type Fetched, type HttpClient } from "../http.ts";
import { decodeProjects } from "../decode.ts";
import { isPending, type Evidence, type IssueCheck } from "./decide.ts";
import { isOperationPolicy, type Policy } from "./policy.ts";
import type { VerifyState } from "./state.ts";

export const POLL_REQUEST_LIMIT = 6;
export const TOTAL_REQUEST_LIMIT = 60;
export const POLL_INTERVAL_MS = 15 * 60_000;
export const ISSUE_VERSION_LIMIT = 2;
const ISSUE_PAGE = 50;
const OBSERVED_PROJECT = "stats";

export class BudgetExhausted extends Error {
  readonly scope: "poll" | "total";

  constructor(scope: "poll" | "total") {
    super(scope === "poll" ? `a poll may make at most ${POLL_REQUEST_LIMIT} requests` : `a verify may make at most ${TOTAL_REQUEST_LIMIT} requests`);
    this.name = "BudgetExhausted";
    this.scope = scope;
  }
}

export interface RequestBudget {
  beginPoll(): void;
  total(): number;
  json<T>(path: string, decode: (value: unknown) => T, ifNoneMatch?: string, bodyLimit?: number): Promise<Fetched<T>>;
}

export function requestBudget(http: HttpClient, priorRequests: number, runStart: number): RequestBudget {
  let pollStart = http.requests();
  const total = () => priorRequests + http.requests() - runStart;
  return {
    beginPoll: () => { pollStart = http.requests(); },
    total,
    async json(path, decode, ifNoneMatch, bodyLimit) {
      if (http.requests() - pollStart >= POLL_REQUEST_LIMIT) throw new BudgetExhausted("poll");
      if (total() >= TOTAL_REQUEST_LIMIT) throw new BudgetExhausted("total");
      return http.getJson(path, decode, { ...(ifNoneMatch === undefined ? {} : { ifNoneMatch }), ...(bodyLimit === undefined ? {} : { bodyLimit }) });
    }
  };
}

export interface Gathered {
  readonly evidence: Evidence;
  readonly etags: Readonly<Record<string, string>>;
  readonly exhausted: BudgetExhausted | null;
}

export function comparisonPath(project: string, deploymentId: string, window: string): string {
  return `/api/v1/projects/${encodeURIComponent(project)}/deployments/${encodeURIComponent(deploymentId)}/comparison?window=${window}`;
}

export function observeWindowPath(fromMs: number, toMs: number, operation?: string, workloadClass?: string): string {
  const query = new URLSearchParams({ from: String(fromMs), to: String(toMs) });
  if (operation !== undefined) query.set("operation", operation);
  if (workloadClass !== undefined) query.set("class", workloadClass);
  return `/api/observe/${OBSERVED_PROJECT}/window?${query}`;
}

function notModifiedWithoutBase(path: string): never {
  throw transportError("contract", `${path} answered not-modified with nothing cached`);
}

export async function gatherEvidence(budget: RequestBudget, state: VerifyState, nowMs: number): Promise<Gathered> {
  const { policy, project, deploymentId, window } = state;
  const previous = state.evidence;
  const etags: Record<string, string> = { ...state.etags };

  async function conditional<T>(path: string, decode: (value: unknown) => T, base: T | undefined, bodyLimit?: number): Promise<T> {
    const etag = base === undefined ? undefined : etags[path];
    const fetched = await budget.json(path, decode, etag, bodyLimit);
    if (fetched.kind === "ok") {
      if (fetched.etag === null) delete etags[path];
      else etags[path] = fetched.etag;
      return fetched.value;
    }
    return base ?? notModifiedWithoutBase(path);
  }

  const path = comparisonPath(project, deploymentId, window);
  let evidence: Evidence | null = previous === null ? null : { ...previous, windows: null, issues: null };
  try {
    const comparison = await conditional(path, value => decodeDeploymentComparison(value, deploymentId, window), previous?.comparison);
    const deployedAtMs = previous?.deployedAtMs ?? await deploymentTime(budget, project, deploymentId);
    evidence = { comparison, deployedAtMs, windows: null, issues: null, probes: previous?.probes ?? null };
    if (isPending(comparison, nowMs) || project !== OBSERVED_PROJECT) return { evidence, etags, exhausted: null };

    if (evidence.probes === null && policy.guardrails.includes("probe-failure-share")) {
      const projects = await budget.json("/api/v1/projects", decodeProjects);
      if (projects.kind !== "ok") return notModifiedWithoutBase("/api/v1/projects");
      const found = projects.value.find(item => item.id === project);
      evidence = { ...evidence, probes: found === undefined ? null : found.probes.map(probe => probe.name) };
    }

    const scoped = scopedSpec(policy, comparison.spec);
    const read = (side: "before" | "after", base: StatsWindow | undefined) => {
      const query = windowQuery(scoped, side);
      return conditional(observeWindowPath(query.fromMs, query.toMs, query.operation), decodeStatsWindow, base, HISTORY_BODY_LIMIT);
    };
    const before = await read("before", previous?.windows?.before);
    const after = await read("after", previous?.windows?.after);
    evidence = { ...evidence, windows: { before, after } };

    const candidates = comparison.spec.after.versionIds.filter(id => !comparison.spec.before.versionIds.includes(id));
    const versions: { versionId: string; groups: number }[] = [];
    for (const versionId of candidates.slice(0, ISSUE_VERSION_LIMIT)) {
      const issuePath = `/api/observe/${OBSERVED_PROJECT}/issues?${new URLSearchParams({ introducedIn: versionId, limit: String(ISSUE_PAGE) })}`;
      const page = await conditional(issuePath, value => decodeIssues(value).items.length, previous?.issues?.versions.find(item => item.versionId === versionId)?.groups);
      versions.push({ versionId, groups: page });
    }
    const issues: IssueCheck = { versions, skipped: candidates.slice(ISSUE_VERSION_LIMIT) };
    evidence = { ...evidence, issues };
    return { evidence, etags, exhausted: null };
  } catch (error) {
    if (error instanceof BudgetExhausted && evidence !== null) return { evidence, etags, exhausted: error };
    throw error;
  }
}

async function deploymentTime(budget: RequestBudget, project: string, deploymentId: string): Promise<number> {
  const path = `/api/v1/projects/${encodeURIComponent(project)}/deployments`;
  const fetched = await budget.json(path, value => decodeDeploymentHistory(value, project));
  if (fetched.kind !== "ok") return notModifiedWithoutBase(path);
  const found = fetched.value.deployments.find(item => item.id === deploymentId);
  if (found === undefined) throw transportError("deployment_missing", `${path} does not list deployment ${deploymentId}`);
  return found.atMs;
}

function scopedSpec(policy: Policy, spec: Evidence["comparison"]["spec"]): Evidence["comparison"]["spec"] {
  if (!isOperationPolicy(policy)) return spec;
  const scope: ComparisonScope = policy.operation === "host.history" || policy.operation === "project.history" ? { operation: policy.operation, workloadClass: policy.workloadClass } : { operation: policy.operation, workloadClass: null };
  return scopeSpec(spec, scope);
}
