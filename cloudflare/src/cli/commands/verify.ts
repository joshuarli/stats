import { isComparisonWindow, type ComparisonWindow } from "../../deployments/compare.ts";
import type { ComparisonSpec } from "../../compare/spec.ts";
import { decodeDeploymentComparison } from "../../deployments/decode.ts";
import { UUID } from "../../deployments/model.ts";
import { decodeHealth, decodeStatsWindow } from "../../observe/client/decode.ts";
import { DEFAULT_ORIGIN } from "../auth.ts";
import { decodeProjects } from "../decode.ts";
import type { ResultMeta, Warning } from "../envelope.ts";
import { EXIT, transportError, unsupportedOnTarget, usageError, type ExitCode } from "../exit.ts";
import { defineCommand, type Command, type CommandContext } from "../registry.ts";
import { MEASUREMENT_REVISION } from "../revisions.ts";
import { SERVICE_LEVEL_METRICS, SERVICE_WORK_METRICS } from "../../deployments/service-compare.ts";
import { table, timeText } from "../text.ts";
import { EXIT_FOR_VERDICT, type Decision, type Reason, type SafetyRecord, type VerifyVerdict } from "../verify/decide.ts";
import { parseDuration, readPolicyFile, readSafetyFile, readServicePolicyFile, resolveInvocationPath, sleepUntil, source } from "../verify/files.ts";
import { verifyService, type ServiceVerdictPayload } from "../verify/service.ts";
import { POLL_REQUEST_LIMIT, TOTAL_REQUEST_LIMIT, comparisonPath, observeWindowPath } from "../verify/gather.ts";
import { replay, resolveLatest, runVerification, type LoopDeps, type Outcome } from "../verify/loop.ts";
import { GUARDRAIL_IDS, MAX_WAIT_MS, MIN_CHANGE_PERCENT, MIN_WAIT_MS, DEFAULT_OPERATION_FLOORS, UNWAIVABLE, isOperationPolicy, policyHash, type Policy } from "../verify/policy.ts";
import { readinessSignals, readinessWindow, type ReadinessSignal } from "../verify/readiness.ts";
import { DEFAULT_STATE_DIRECTORY, readStateText } from "../verify/state.ts";
import { OBSERVED_PROJECT } from "./health.ts";
import { requireProject } from "./deployments.ts";

export interface ReadinessPayload {
  readonly kind: "readiness";
  readonly policy: { readonly id: string; readonly hash: string };
  readonly deployment: { readonly requested: string; readonly id: string };
  readonly ready: boolean;
  readonly signals: readonly ReadinessSignal[];
  readonly requests: number;
}

export interface VerdictPayload {
  readonly kind: "verdict";
  readonly verdict: VerifyVerdict;
  readonly policy: { readonly id: string; readonly hash: string; readonly hypothesis: string; readonly operation: Policy["operation"]; readonly metric: string };
  readonly deployment: { readonly requested: string; readonly id: string };
  readonly window: ComparisonWindow;
  readonly spec: ComparisonSpec | null;
  readonly decision: Decision | null;
  readonly reasons: readonly Reason[];
  readonly safety: SafetyRecord | null;
  readonly overhead: { readonly polls: number; readonly requests: number; readonly requestLimit: number; readonly pollRequestLimit: number };
  readonly wait: { readonly requested: boolean; readonly timedOut: boolean; readonly interrupted: boolean; readonly resume: string | null };
  readonly state: { readonly path: string; readonly reusedFinal: boolean };
  readonly replay: { readonly file: string; readonly reproduced: true } | null;
}

export type VerifyPayload = ReadinessPayload | VerdictPayload | ServiceVerdictPayload;

export interface VerifyDeps {
  readonly sleep: LoopDeps["sleep"];
  readonly stateDirectory: string;
}

const POLICY_FIELD_HELP: readonly (readonly [string, string])[] = [
  ["schema", `must be "statsctl-policy/1"`],
  ["id", "short name, lowercase letters, digits, hyphens; names the experiment in saved JSON"],
  ["hypothesis", "one sentence, registered before the deploy: what should change and why"],
  ["project", "project id; operation summaries and issues exist only for stats"],
  ["operation", `host.ingest, host.history, project.history, collector.record, or "global" for a project-wide metric`],
  ["workloadClass", "required for host.history and project.history, forbidden otherwise; the class label from the observe window"],
  ["metric", "cpuMsPerUnit comes from tail cpuTime, rounded to whole milliseconds per invocation (default floor 0.5 ms, warning cpu-quantized-ms in every output). Operation policies: cpuMsPerUnit, wallMsPerUnit, rowsReadPerUnit, rowsWrittenPerUnit, statementsPerUnit (per work unit: persisted sample, request, run, row expired). Global: worker.cpu, worker.errors, do.cpu, do.wall, d1.read, d1.write, cost, r2.<bucket>, probe.<name>.ms, probe.<name>.failure"],
  ["direction", "decrease or increase: which way the metric must move for the change to count as improved"],
  ["minChangePercent", `smallest relative change that counts as material, at least ${MIN_CHANGE_PERCENT}`],
  ["floor", `smallest absolute change that counts as material, at least the metric default (operation defaults: ${Object.entries(DEFAULT_OPERATION_FLOORS).map(([name, value]) => `${name} ${value}`).join(", ")})`],
  ["guardrails", `ids that must pass: ${GUARDRAIL_IDS.join(", ")}; all are required by default (ingest-persistence applies to host.ingest only)`],
  ["waivedGuardrails", `optional [{guardrail, reason}] for a required guardrail left out of guardrails, reason 10 to 300 characters; ${UNWAIVABLE.join(" and ")} can never be waived`],
  ["window", "1h, 6h, or 24h comparison window; --window may only repeat it"],
  ["maxWaitMs", `longest one --wait run may sleep, ${MIN_WAIT_MS} to ${MAX_WAIT_MS}; --timeout can only shorten it`]
];

const GUARDRAIL_HELP: readonly (readonly [string, string])[] = [
  ["safety-check", "a saved `check ingest --json` that passed, run after the deploy began and before the after window"],
  ["failed-share", "operation failures: none if the before side had none, else the share may rise at most 1 point"],
  ["new-issue-group", "no observe issue group whose first version is the candidate; a group with the same operation and error name as one seen since the before window began, under another fingerprint, is `regrouped` and makes the verdict confounded"],
  ["probe-failure-share", "no probe failure share rose by 1 point or more; not applicable when the project defines no probes"],
  ["coverage", "observe events reconcile with analytics invocations within 5% on both sides"],
  ["ingest-persistence", "(persisted + duplicate) / received, in percent, does not fall by more than 1 point; rejected samples stay in the denominator (host.ingest only)"]
];

function pad(rows: readonly (readonly [string, string])[]): string[] {
  return table(rows.map(([name, text]) => [`  ${name}`, text]));
}

function resumeCommand(context: CommandContext, deploymentId: string, policyFile: string, windowSpan: string, safetyFile: string | undefined, timeout: string): string {
  const parts = ["pnpm --dir cloudflare -s statsctl verify", `--project ${context.option("project") ?? ""}`, `--deployment ${deploymentId}`, `--window ${windowSpan}`, `--policy ${policyFile}`];
  if (safetyFile !== undefined) parts.push(`--safety-check-file ${safetyFile}`);
  if (context.origin !== DEFAULT_ORIGIN) parts.push(`--origin ${context.origin}`);
  parts.push("--wait", `--timeout ${timeout}`);
  if (context.flag("json")) parts.push("--json");
  return parts.join(" ");
}

const CPU_QUANTIZED_WARNING = "cpu-quantized-ms";

function verdictMeta(payload: VerdictPayload, project: string): ResultMeta {
  const spec = payload.spec;
  const decision = payload.decision;
  const versionIds = spec === null ? [] : [...new Set([...spec.before.versionIds, ...spec.after.versionIds])];
  const warnings: Warning[] = (decision?.warnings ?? []).map(message => ({ code: "comparison-warning", message }));
  if (payload.policy.operation !== "global" && payload.policy.metric === "cpuMsPerUnit") warnings.push({ code: CPU_QUANTIZED_WARNING, message: "tail cpuTime is rounded to whole milliseconds per invocation, so a cpuMsPerUnit change below the rounding error is not resolvable; its floor is at least 0.5 ms" });
  return {
    project,
    windows: spec === null ? [] : [{ fromMs: spec.before.fromMs, toMs: spec.before.toMs }, { fromMs: spec.after.fromMs, toMs: spec.after.toMs }],
    measurementRevision: MEASUREMENT_REVISION,
    coverage: decision?.coverage.state == null ? {} : { state: decision.coverage.state, before: decision.coverage.before?.state ?? "unread", after: decision.coverage.after?.state ?? "unread" },
    units: decision?.unit == null ? {} : { [payload.policy.id]: decision.unit },
    warnings,
    identities: { deploymentIds: [payload.deployment.id], versionIds }
  };
}

function verdictPayload(outcome: Outcome, context: CommandContext, input: { readonly policy: Policy; readonly requested: string; readonly wait: boolean; readonly resume: string | null }): VerdictPayload {
  const { state, decision } = outcome;
  const resumable = input.resume !== null && (outcome.verdict === "pending" || outcome.verdict === "insufficient-data");
  return {
    kind: "verdict",
    verdict: outcome.verdict,
    policy: { id: state.policy.id, hash: state.policyHash, hypothesis: state.policy.hypothesis, operation: state.policy.operation, metric: state.policy.metric },
    deployment: { requested: input.requested, id: state.deploymentId },
    window: state.window,
    spec: state.evidence?.comparison.spec ?? null,
    decision,
    reasons: [...(decision?.reasons ?? []), ...outcome.extraReasons, ...(outcome.interrupted ? [{ code: "interrupted", message: "stopped by a signal; the state is saved" }] : []), ...(outcome.timedOut ? [{ code: "timeout", message: "the next poll falls after the deadline" }] : [])],
    safety: state.safety,
    overhead: { polls: state.polls, requests: state.requests, requestLimit: TOTAL_REQUEST_LIMIT, pollRequestLimit: POLL_REQUEST_LIMIT },
    wait: { requested: input.wait, timedOut: outcome.timedOut, interrupted: outcome.interrupted, resume: resumable ? input.resume : null },
    state: { path: outcome.statePath, reusedFinal: outcome.reusedFinal },
    replay: null
  };
}

export function createVerifyCommand(deps: VerifyDeps): Command {
  return defineCommand<VerifyPayload>({
    name: "verify",
    summary: "decide whether a deployment used fewer resources for the same work, or (--service) changed a service's resource levels",
    description: [
      "Applies a pre-registered policy to the exact before and after windows of one deployment and prints a verdict: improved, unchanged, confounded, insufficient-data, pending, or regressed.",
      "Read-only. It never runs `check ingest`; run that yourself inside the deployment warm-up and pass its saved --json output with --safety-check-file. A missing, failed, or pre-deploy check never passes.",
      "",
      "Verdict precedence: regressed (any guardrail regressed, or the target metric moved the wrong way materially) > confounded (overlap, split or deferred rollout, workload drift, a history 304-share move above 20 points (cache-mix), or a global comparison reason) > insufficient-data (a side lacks operations, coverage is not reconciled, or any guardrail has no evidence) > pending (the after window has not settled) > improved or unchanged.",
      "An insufficient guardrail is never a pass. Missing data is never zero. Exit codes: 0 improved, 5 pending or insufficient-data, 6 unchanged or confounded, 7 regressed.",
      "",
      "--deployment latest resolves once to an immutable id, pinned in .work/statsctl/verify/<deployment-id>.json together with the policy hash, the exact comparison spec, the safety check, poll and request counts, and the evidence behind the last verdict.",
      "A deployment the collector has not recorded yet is pending (reason deployment-unrecorded), and --wait retries every 5 minutes; once a deployment sync that began after this verify started still does not list it, verify fails with deployment_missing (exit 4). Do not write to the state file yourself; redirect --json output elsewhere.",
      "--wait sleeps until the comparison's readyAtMs before reading data, then polls at most once every 15 minutes with If-None-Match, at most 6 requests a poll and 60 in all (counted across runs). On --timeout, on the policy's maxWaitMs, or on SIGINT or SIGTERM it saves the state and exits 5 with the exact command to resume.",
      "A finished run (improved, unchanged, confounded, regressed) is not re-read: repeating the command prints the saved verdict. --replay FILE re-derives the verdict from a state file with no network and fails with exit 4 if it differs from the recorded one.",
      "--readiness lists each signal the policy needs as available or unavailable:<code> with a sentence, and exits 0 if all are available, else 5. A meter the policy does not use never blocks it.",
      "",
      "Policy file (JSON, strict: unknown fields are rejected), schema statsctl-policy/1:",
      ...pad(POLICY_FIELD_HELP),
      "",
      "Guardrails:",
      ...pad(GUARDRAIL_HELP),
      "",
      "Service policy (--service), schema statsctl-policy/1, strict: schema, id, hypothesis, service, metric, operation, work, direction, minChangePercent, floor, window.",
      `  metric is one of ${SERVICE_LEVEL_METRICS.map(entry => entry.metric).join(", ")} for resource levels, or one of ${SERVICE_WORK_METRICS.map(entry => entry.metric).join(", ")} for application work. Resource-level metrics take no operation or work; application.duration and application.failure take operation; the per-work metrics take operation and work. A work metric is reported only when the counter is complete; a service cgroup resource is divided by work only when one operation owns the service's successful events in that window. application.cpuPerWork and application.ioPerWork are per observed work (producer drops, rejected batches and sequence gaps are not recorded) and are unavailable when a five-minute bucket had no events while the service was up (reason application-gap); a truncated or failed application read makes every application metric insufficient-data (reason application-truncated or application-unavailable).`,
      `  floor is at least the metric's default (${[...SERVICE_LEVEL_METRICS, ...SERVICE_WORK_METRICS].map(entry => `${entry.metric} ${entry.floor}`).join(", ")}). There are no guardrails and no waiting: a window that has not settled is pending (exit 5), so run it again later.`,
      "  The output states that resource levels and per-work ratios are descriptive, not causal. The marker's hosts are compared before and after: host metrics count every process on them, and when the service's cgroup reports in both windows its service.cpu, service.memory, and service.io supersede host.cpu, host.memory, and host.disk, which stay in the response marked supersededBy and which a policy can still target.",
      "",
      "Target judgement: the metric is the sum over the operation's organic (non-synthetic) buckets divided by its work denominator, per side, with at least 100 operations on each side. It counts only when the change is at least minChangePercent and floor. Moving the wrong way by that much is regressed; a smaller move is unchanged."
    ],
    access: "read",
    targets: ["orange", "node"],
    options: {
      project: { type: "string", placeholder: "ID", description: "project id from `statsctl projects`; must match the policy (required unless --replay or --service)" },
      service: { type: "string", placeholder: "NAME", description: "verify a service's deployment marker from `statsctl services` instead of a project; takes a service policy (see below), one read, no waiting" },
      deployment: { type: "string", placeholder: "ID", description: "deployment id from `statsctl deployments`, or latest (required unless --replay)" },
      window: { type: "string", placeholder: "SPAN", description: "comparison window, 1h, 6h, or 24h; defaults to the policy's window and may not differ from it" },
      policy: { type: "string", placeholder: "FILE", description: "policy JSON file, e.g. bench/policies/<id>.json (required unless --replay)" },
      "safety-check-file": { type: "string", placeholder: "FILE", description: "saved output of `statsctl check ingest --json` run inside the deployment warm-up" },
      wait: { type: "boolean", description: "wait for the after window to settle instead of exiting pending" },
      timeout: { type: "string", placeholder: "SPAN", default: "30m", description: "give up waiting after this span (s, m, h, d) and exit 5 with a resume command" },
      readiness: { type: "boolean", description: "list each signal the policy needs as available or unavailable and exit" },
      replay: { type: "string", placeholder: "FILE", description: "re-derive the verdict from a saved state file, offline" }
    },
    exclusive: [["service", "project"], ["service", "wait"], ["service", "readiness"], ["service", "replay"], ["service", "safety-check-file"], ["replay", "wait"], ["replay", "readiness"], ["replay", "policy"], ["replay", "project"], ["replay", "deployment"], ["replay", "safety-check-file"], ["readiness", "wait"]],
    examples: [
      "statsctl verify --project stats --deployment DEPLOYMENT_ID --policy bench/policies/EXPERIMENT.json --readiness --json",
      "statsctl verify --project stats --deployment DEPLOYMENT_ID --policy bench/policies/EXPERIMENT.json --safety-check-file .work/check-ingest.json --wait --timeout 2h --json",
      "statsctl verify --replay .work/statsctl/verify/DEPLOYMENT_ID.json --json"
    ],
    limitations: [
      "A full verify makes at most 60 requests; a poll makes at most 6.",
      "--service compares resource levels only (host CPU, memory, pressure, network, disk, and health probe time or failure share). It cannot show fewer resources for the same work, because a service does not report its own work counts.",
      "Operation summaries, coverage, and issue groups exist only for the stats project.",
      "--service works on Cloudflare and Node origins; every other mode reads Cloudflare telemetry and exits 2 with unsupported_on_target on a Node origin.",
      "At most two candidate versions are checked for new issue groups; more is insufficient-data.",
      "Global policies need 1,000 invocations a side for the failed-share guardrail, so a small project cannot pass one."
    ],
    async run(context) {
      const replayFile = context.option("replay");
      if (replayFile !== undefined) {
        if (context.target === "node") throw unsupportedOnTarget("verify without --service", context.target, context.origin);
        const path = resolveInvocationPath(replayFile);
        const text = readStateText(path);
        if (text === null) throw usageError(`cannot open the state file ${path}`);
        const { state, decision } = replay(text, path);
        const outcome: Outcome = { state, statePath: path, verdict: decision.verdict, decision, timedOut: false, interrupted: false, reusedFinal: false, extraReasons: [] };
        const payload: VerdictPayload = { ...verdictPayload(outcome, context, { policy: state.policy, requested: state.requested, wait: false, resume: null }), replay: { file: path, reproduced: true } };
        return { ...verdictMeta(payload, state.project), payload, exit: EXIT_FOR_VERDICT[decision.verdict] };
      }

      const serviceName = context.option("service");
      if (serviceName !== undefined) return serviceVerification(context, serviceName);
      if (context.target === "node") throw unsupportedOnTarget("verify without --service", context.target, context.origin);

      const project = requireProject(context);
      const requested = context.option("deployment");
      const policyFile = context.option("policy");
      if (requested === undefined || policyFile === undefined) throw usageError("--deployment and --policy are required unless --replay is given");
      if (requested !== "latest" && !UUID.test(requested)) throw usageError("--deployment must be a deployment id or latest");
      const policy = readPolicyFile(policyFile);
      if (policy.project !== project) throw usageError(`the policy is for project ${policy.project}, not ${project}`);
      const windowSpan = context.option("window") ?? policy.window;
      if (!isComparisonWindow(windowSpan) || windowSpan !== policy.window) throw usageError(`--window must match the policy's pre-registered window ${policy.window}`);
      const safetyFile = context.option("safety-check-file");
      const safety = safetyFile === undefined ? null : readSafetyFile(safetyFile, context.origin);

      if (context.flag("readiness")) return readiness(context, policy, requested, safety);

      const timeoutText = context.option("timeout") ?? "30m";
      const wait = context.flag("wait");
      const loopDeps: LoopDeps = { http: context.http, now: context.now, sleep: deps.sleep, signal: context.signal, stateDirectory: deps.stateDirectory };
      const outcome = await runVerification(loopDeps, { origin: context.origin, project, requested, window: windowSpan, policy, wait, timeoutMs: parseDuration(timeoutText), safety });
      const resume = resumeCommand(context, outcome.state.deploymentId, policyFile, windowSpan, safetyFile, timeoutText);
      const payload = verdictPayload(outcome, context, { policy, requested, wait, resume });
      return { ...verdictMeta(payload, project), payload, exit: EXIT_FOR_VERDICT[outcome.verdict] };
    },
    render(payload) {
      return payload.kind === "readiness" ? renderReadiness(payload) : payload.kind === "service-verdict" ? renderServiceVerdict(payload) : renderVerdict(payload);
    }
  });
}

async function serviceVerification(context: CommandContext, serviceName: string): Promise<{ payload: ServiceVerdictPayload; exit: ExitCode } & ResultMeta> {
  const requested = context.option("deployment");
  const policyFile = context.option("policy");
  if (requested === undefined || policyFile === undefined) throw usageError("--deployment and --policy are required with --service");
  const policy = readServicePolicyFile(policyFile);
  if (policy.service !== serviceName) throw usageError(`the policy is for service ${policy.service}, not ${serviceName}`);
  const windowSpan = context.option("window") ?? policy.window;
  if (!isComparisonWindow(windowSpan) || windowSpan !== policy.window) throw usageError(`--window must match the policy's pre-registered window ${policy.window}`);
  const payload = await verifyService(context.http, context.now(), policy, requested);
  return {
    project: serviceName,
    windows: [{ fromMs: payload.spec.before.fromMs, toMs: payload.spec.before.toMs }, { fromMs: payload.spec.after.fromMs, toMs: payload.spec.after.toMs }],
    measurementRevision: MEASUREMENT_REVISION,
    warnings: [{ code: "resource-levels-and-work", message: payload.caveat }],
    identities: { deploymentIds: [payload.deployment.id], versionIds: [...new Set([...payload.spec.before.versionIds, ...payload.spec.after.versionIds])] },
    payload,
    exit: EXIT_FOR_VERDICT[payload.verdict]
  };
}

async function readiness(context: CommandContext, policy: Policy, requested: string, safety: SafetyRecord | null): Promise<{ payload: ReadinessPayload; exit: ExitCode } & ResultMeta> {
  const before = context.http.requests();
  const deploymentId = requested === "latest" ? await resolveLatest(context.http, policy.project) : requested;
  const observed = policy.project === OBSERVED_PROJECT;
  const fetchValue = async <T>(path: string, decode: (value: unknown) => T): Promise<T> => {
    const fetched = await context.http.getJson(path, decode);
    if (fetched.kind !== "ok") throw transportError("contract", `${path} answered not-modified to an unconditional request`);
    return fetched.value;
  };
  const projects = await source(() => fetchValue("/api/v1/projects", decodeProjects));
  const comparison = await source(() => fetchValue(comparisonPath(policy.project, deploymentId, policy.window), value => decodeDeploymentComparison(value, deploymentId, policy.window)));
  const observeHealth = observed ? await source(() => fetchValue(`/api/observe/${OBSERVED_PROJECT}/health`, decodeHealth)) : null;
  const span = readinessWindow(context.now(), policy);
  const window = observed ? await source(() => fetchValue(observeWindowPath(OBSERVED_PROJECT, span.fromMs, span.toMs, isOperationPolicy(policy) ? policy.operation : undefined, policy.workloadClass ?? undefined), decodeStatsWindow)) : null;
  const project = projects.ok
    ? (() => { const found = projects.value.find(item => item.id === policy.project); return found === undefined ? { ok: false as const, code: "unknown_project", message: `unknown project ${policy.project}` } : { ok: true as const, value: found }; })()
    : projects;
  const signals = readinessSignals(policy, { nowMs: context.now(), project, observeHealth, window, comparison, safety });
  const ready = signals.every(signal => signal.status === "available");
  const payload: ReadinessPayload = { kind: "readiness", policy: { id: policy.id, hash: policyHash(policy) }, deployment: { requested, id: deploymentId }, ready, signals, requests: context.http.requests() - before };
  return { project: policy.project, identities: { deploymentIds: [deploymentId] }, measurementRevision: MEASUREMENT_REVISION, payload, exit: ready ? EXIT.ok : EXIT.pending };
}

function renderReadiness(payload: ReadinessPayload): string[] {
  return [
    `readiness for policy ${payload.policy.id} on deployment ${payload.deployment.id}: ${payload.ready ? "ready" : "NOT ready"}`,
    ...table(payload.signals.map(signal => [signal.signal, signal.status, signal.message]))
  ];
}

function renderServiceVerdict(payload: ServiceVerdictPayload): string[] {
  const { target } = payload;
  return [
    `service verdict ${payload.verdict} (exit ${EXIT_FOR_VERDICT[payload.verdict]}) for policy ${payload.policy.id}`,
    `hypothesis: ${payload.policy.hypothesis}`,
    `service ${payload.policy.service}, deployment ${payload.deployment.id}${payload.deployment.requested === "latest" ? " (resolved from latest)" : ""}, window ${payload.window}`,
    `before [${timeText(payload.spec.before.fromMs)}, ${timeText(payload.spec.before.toMs)})`,
    `after  [${timeText(payload.spec.after.fromMs)}, ${timeText(payload.spec.after.toMs)})`,
    ...table([
      ["target", "direction", "before", "after", "delta", "percent", "verdict"],
      [target.metric, target.direction, number(target.before), number(target.after), number(target.delta), number(target.deltaPercent), target.verdict]
    ]),
    "sources:",
    ...table(payload.sources.map(item => [`  ${item.source}`, item.status, item.detail])),
    ...(payload.reasons.length > 0 ? ["reasons:", ...payload.reasons.map(reason => `  ${reason.code}: ${reason.message}`)] : []),
    `caveat: ${payload.caveat}`
  ];
}

function number(value: number | null): string {
  return value === null ? "unavailable" : String(Number(value.toFixed(4)));
}

function renderVerdict(payload: VerdictPayload): string[] {
  const { decision } = payload;
  const lines = [
    `verdict ${payload.verdict} (exit ${EXIT_FOR_VERDICT[payload.verdict]}) for policy ${payload.policy.id}`,
    `hypothesis: ${payload.policy.hypothesis}`,
    `deployment ${payload.deployment.id}${payload.deployment.requested === "latest" ? " (resolved from latest)" : ""}, window ${payload.window}`
  ];
  if (payload.spec !== null) {
    lines.push(`before [${timeText(payload.spec.before.fromMs)}, ${timeText(payload.spec.before.toMs)})`, `after  [${timeText(payload.spec.after.fromMs)}, ${timeText(payload.spec.after.toMs)})`);
  }
  if (decision !== null) {
    const { target } = decision;
    lines.push(...table([
      ["target", "direction", "before", "after", "delta", "percent", "verdict"],
      [target.metric, target.direction, number(target.before), number(target.after), number(target.delta), number(target.deltaPercent), target.verdict]
    ]));
    if (decision.operations !== null && decision.workUnits !== null) lines.push(`operations ${decision.operations.before} -> ${decision.operations.after}; ${decision.unit ?? "work unit"}s ${decision.workUnits.before} -> ${decision.workUnits.after}`);
    lines.push("guardrails:", ...table(decision.guardrails.map(item => [`  ${item.id}`, item.status, item.detail])));
    if (decision.blockedBy.length > 0) lines.push(`blocked by: ${decision.blockedBy.join(", ")}`);
  }
  if (payload.reasons.length > 0) lines.push("reasons:", ...payload.reasons.map(reason => `  ${reason.code}: ${reason.message}`));
  lines.push(`requests ${payload.overhead.requests} of ${payload.overhead.requestLimit}, polls ${payload.overhead.polls}; state ${payload.state.path}`);
  if (payload.wait.resume !== null) lines.push(`resume: ${payload.wait.resume}`);
  if (payload.replay !== null) lines.push(`replayed offline from ${payload.replay.file}: the verdict is reproduced`);
  return lines;
}

export const verifyCommand = createVerifyCommand({ sleep: sleepUntil, stateDirectory: DEFAULT_STATE_DIRECTORY });
