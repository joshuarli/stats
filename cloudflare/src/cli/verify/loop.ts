import type { ComparisonWindow } from "../../deployments/compare.ts";
import { decodeDeploymentHistory } from "../../deployments/decode.ts";
import { UUID } from "../../deployments/model.ts";
import { CommandError, EXIT, transportError, usageError } from "../exit.ts";
import type { HttpClient } from "../http.ts";
import { decide, isPending, type Decision, type Reason, type SafetyRecord, type VerifyVerdict } from "./decide.ts";
import { BudgetExhausted, POLL_INTERVAL_MS, gatherEvidence, requestBudget } from "./gather.ts";
import { policyHash, type Policy } from "./policy.ts";
import { STATE_SCHEMA, decodeState, readStateText, statePath, writeState, type VerifyState } from "./state.ts";

const FINAL_VERDICTS: readonly VerifyVerdict[] = ["improved", "unchanged", "confounded", "regressed"];

export interface LoopDeps {
  readonly http: HttpClient;
  readonly now: () => number;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<boolean>;
  readonly signal: AbortSignal;
  readonly stateDirectory: string;
}

export interface VerificationRequest {
  readonly origin: string;
  readonly project: string;
  readonly requested: string;
  readonly window: ComparisonWindow;
  readonly policy: Policy;
  readonly wait: boolean;
  readonly timeoutMs: number;
  readonly safety: SafetyRecord | null;
}

export interface Outcome {
  readonly state: VerifyState;
  readonly statePath: string;
  readonly verdict: VerifyVerdict;
  readonly decision: Decision | null;
  readonly timedOut: boolean;
  readonly interrupted: boolean;
  readonly reusedFinal: boolean;
  readonly extraReasons: readonly Reason[];
}

export async function resolveLatest(http: HttpClient, project: string): Promise<string> {
  const path = `/api/v1/projects/${encodeURIComponent(project)}/deployments`;
  const fetched = await http.getJson(path, value => decodeDeploymentHistory(value, project));
  if (fetched.kind !== "ok") throw transportError("contract", `${path} answered not-modified to an unconditional request`);
  const newest = [...fetched.value.deployments].sort((a, b) => b.atMs - a.atMs || a.id.localeCompare(b.id))[0];
  if (newest === undefined) throw transportError("no_deployments", `no deployments are recorded for ${project}`);
  return newest.id;
}

function requireSameRun(state: VerifyState, request: VerificationRequest, path: string): void {
  const mismatch = state.policyHash !== policyHash(request.policy) ? "a different policy"
    : state.project !== request.project ? "a different project"
    : state.window !== request.window ? "a different window"
    : state.origin !== request.origin ? "a different origin"
    : null;
  if (mismatch !== null) throw usageError(`${path} belongs to ${mismatch}; remove it to start over`);
}

export async function runVerification(deps: LoopDeps, request: VerificationRequest): Promise<Outcome> {
  const runBase = deps.http.requests();
  const runStartedAt = deps.now();
  if (request.requested !== "latest" && !UUID.test(request.requested)) throw usageError("--deployment must be a deployment id or latest");
  const deploymentId = request.requested === "latest" ? await resolveLatest(deps.http, request.project) : request.requested;

  const path = statePath(deps.stateDirectory, deploymentId);
  const existing = readStateText(path);
  const loaded = existing === null ? null : decodeState(existing, path);
  if (loaded !== null) requireSameRun(loaded, request, path);
  const prior = loaded?.requests ?? 0;
  const budget = requestBudget(deps.http, prior, runBase);
  let state: VerifyState = loaded === null
    ? {
      schema: STATE_SCHEMA, origin: request.origin, project: request.project, requested: request.requested, deploymentId, window: request.window,
      policy: request.policy, policyHash: policyHash(request.policy), pinnedAtMs: runStartedAt, polls: 0, requests: 0,
      etags: {}, safety: request.safety, evidence: null, last: null
    }
    : { ...loaded, safety: request.safety ?? loaded.safety };
  const save = (next: VerifyState): VerifyState => {
    const counted = { ...next, requests: budget.total() };
    writeState(deps.stateDirectory, counted);
    return counted;
  };
  state = save(state);

  const finished = (flags: Partial<Pick<Outcome, "timedOut" | "interrupted" | "reusedFinal" | "extraReasons">>, verdict?: VerifyVerdict): Outcome => {
    const decision = state.evidence === null || state.last === null ? null : decide(state.policy, state.evidence, state.safety, state.last.evaluatedAtMs);
    return { state, statePath: path, verdict: verdict ?? decision?.verdict ?? "pending", decision, timedOut: false, interrupted: false, reusedFinal: false, extraReasons: [], ...flags };
  };

  if (state.last !== null && FINAL_VERDICTS.includes(state.last.verdict) && request.safety === null) return finished({ reusedFinal: true });

  const deadline = runStartedAt + Math.min(request.timeoutMs, request.policy.maxWaitMs);
  for (;;) {
    budget.beginPoll();
    const evaluatedAtMs = deps.now();
    let gathered: Awaited<ReturnType<typeof gatherEvidence>>;
    try {
      gathered = await gatherEvidence(budget, state, evaluatedAtMs);
    } catch (error) {
      state = save(state);
      if (error instanceof BudgetExhausted) throw new CommandError(EXIT.pending, "request_budget", `${error.message}; nothing was read this run`);
      if (deps.signal.aborted && error instanceof CommandError && error.code === "cancelled") return finished({ interrupted: true }, "pending");
      throw error;
    }
    const { evidence, exhausted } = gathered;
    const decision = decide(state.policy, evidence, state.safety, evaluatedAtMs);
    state = save({ ...state, etags: gathered.etags, polls: state.polls + 1, evidence, last: { evaluatedAtMs, verdict: decision.verdict } });
    const extraReasons = exhausted === null ? [] : [budgetReason(exhausted)];
    const waiting = decision.verdict === "pending" || (decision.verdict !== "regressed" && isPending(evidence.comparison, evaluatedAtMs));
    if (!waiting || !request.wait || exhausted !== null) return finished({ extraReasons });

    const wakeAtMs = evaluatedAtMs < evidence.comparison.readyAtMs ? evidence.comparison.readyAtMs : evaluatedAtMs + POLL_INTERVAL_MS;
    if (wakeAtMs > deadline) return finished({ timedOut: true });
    if (!await deps.sleep(Math.max(0, wakeAtMs - deps.now()), deps.signal)) return finished({ interrupted: true });
  }
}

function budgetReason(error: BudgetExhausted): Reason {
  return { code: "request-budget", message: `${error.message}; the evidence read so far is saved` };
}

export function replay(text: string, path: string): { readonly state: VerifyState; readonly decision: Decision } {
  const state = decodeState(text, path);
  if (state.last === null || state.evidence === null) throw new CommandError(EXIT.transport, "replay_empty", `${path} holds no completed evaluation to replay`);
  const decision = decide(state.policy, state.evidence, state.safety, state.last.evaluatedAtMs);
  if (decision.verdict !== state.last.verdict) throw new CommandError(EXIT.transport, "replay_mismatch", `replaying ${path} gives ${decision.verdict}, but it recorded ${state.last.verdict}`);
  return { state, decision };
}
