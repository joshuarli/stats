import { createHash } from "node:crypto";
import { COMPARISON_WINDOWS, type ComparisonWindow } from "../../deployments/compare.ts";
import { OPERATION_METRICS, type MetricFloors, type OperationMetric } from "../../compare/operation.ts";
import { SERVICE_LEVEL_METRICS } from "../../deployments/service-compare.ts";
import type { ClassedOperation, ClasslessOperation, ComparableOperation } from "../../compare/spec.ts";

export const POLICY_SCHEMA = "statsctl-policy/1";
export const MIN_CHANGE_PERCENT = 10;
export const MAX_POLICY_BYTES = 64 * 1024;
export const MIN_WAIT_MS = 60_000;
export const MAX_WAIT_MS = 48 * 3_600_000;

export const GUARDRAIL_IDS = ["safety-check", "failed-share", "new-issue-group", "probe-failure-share", "coverage", "ingest-persistence"] as const;
export type GuardrailId = typeof GUARDRAIL_IDS[number];
export const UNWAIVABLE: readonly GuardrailId[] = ["safety-check", "coverage"];

const COMPARABLE_OPERATIONS: readonly ComparableOperation[] = ["host.ingest", "host.history", "project.history", "collector.record"];
const CLASSED_OPERATIONS: readonly ComparableOperation[] = ["host.history", "project.history"];

export const DEFAULT_OPERATION_FLOORS: MetricFloors = {
  cpuMsPerUnit: 0.5,
  wallMsPerUnit: 0.5,
  rowsReadPerUnit: 0.5,
  rowsWrittenPerUnit: 0.5,
  statementsPerUnit: 0.25
};

const GLOBAL_FLOORS: Readonly<Record<string, number>> = {
  "worker.cpu": 0.1,
  "worker.errors": 0.1,
  "do.cpu": 0.1,
  "do.wall": 1,
  "d1.read": 1,
  "d1.write": 0.1,
  cost: 0.000001
};
const GLOBAL_PATTERN_FLOORS: readonly (readonly [RegExp, number])[] = [
  [/^r2\.[A-Za-z0-9_-]{1,63}$/u, 0.05],
  [/^probe\.[A-Za-z0-9_-]{1,63}\.ms$/u, 10],
  [/^probe\.[A-Za-z0-9_-]{1,63}\.failure$/u, 1]
];

export interface Waiver {
  readonly guardrail: GuardrailId;
  readonly reason: string;
}

interface PolicyCommon {
  readonly schema: typeof POLICY_SCHEMA;
  readonly id: string;
  readonly hypothesis: string;
  readonly project: string;
  readonly direction: "decrease" | "increase";
  readonly minChangePercent: number;
  readonly floor: number;
  readonly guardrails: readonly GuardrailId[];
  readonly waivedGuardrails: readonly Waiver[];
  readonly window: ComparisonWindow;
  readonly maxWaitMs: number;
}

export type Policy =
  | (PolicyCommon & { readonly operation: ClasslessOperation; readonly workloadClass: null; readonly metric: OperationMetric })
  | (PolicyCommon & { readonly operation: ClassedOperation; readonly workloadClass: string; readonly metric: OperationMetric })
  | (PolicyCommon & { readonly operation: "global"; readonly workloadClass: null; readonly metric: string });

export type OperationPolicy = Exclude<Policy, { readonly operation: "global" }>;

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

export function isOperationPolicy(policy: Policy): policy is OperationPolicy {
  return policy.operation !== "global";
}

export function applicableGuardrails(operation: Policy["operation"]): readonly GuardrailId[] {
  return operation === "host.ingest" ? GUARDRAIL_IDS : GUARDRAIL_IDS.filter(id => id !== "ingest-persistence");
}

export function defaultFloor(operation: Policy["operation"], metric: string): number | undefined {
  if (operation !== "global") return (DEFAULT_OPERATION_FLOORS as Readonly<Record<string, number>>)[metric];
  const exact = Object.hasOwn(GLOBAL_FLOORS, metric) ? GLOBAL_FLOORS[metric] : undefined;
  return exact ?? GLOBAL_PATTERN_FLOORS.find(([pattern]) => pattern.test(metric))?.[1];
}

export function operationFloors(policy: OperationPolicy): MetricFloors {
  return { ...DEFAULT_OPERATION_FLOORS, [policy.metric]: policy.floor };
}

const TOP_LEVEL_FIELDS = ["schema", "id", "hypothesis", "project", "operation", "workloadClass", "metric", "direction", "minChangePercent", "floor", "guardrails", "waivedGuardrails", "window", "maxWaitMs"];

function fail(message: string): never {
  throw new PolicyError(message);
}

function record(value: unknown, where: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${where} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}

function noUnknown(fields: Readonly<Record<string, unknown>>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(fields)) if (!allowed.includes(key)) fail(`${where} has unknown field ${key}`);
}

function text(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== "string" || value.trim() !== value || value.length < min || value.length > max) fail(`${name} must be a trimmed string of ${min} to ${max} characters`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  const found = allowed.find(item => item === value);
  if (found === undefined) fail(`${name} must be one of ${allowed.join(", ")}`);
  return found;
}

function number(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${name} must be a finite number`);
  return value;
}

function parseWaivers(value: unknown): Waiver[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > GUARDRAIL_IDS.length) fail("waivedGuardrails must be a list of {guardrail, reason}");
  return value.map((item, index) => {
    const fields = record(item, `waivedGuardrails[${index}]`);
    noUnknown(fields, ["guardrail", "reason"], `waivedGuardrails[${index}]`);
    const guardrail = oneOf(fields["guardrail"], GUARDRAIL_IDS, `waivedGuardrails[${index}].guardrail`);
    if (UNWAIVABLE.includes(guardrail)) fail(`${guardrail} can never be waived`);
    return { guardrail, reason: text(fields["reason"], `waivedGuardrails[${index}].reason`, 10, 300) };
  });
}

export function parsePolicy(value: unknown): Policy {
  const fields = record(value, "the policy");
  noUnknown(fields, TOP_LEVEL_FIELDS, "the policy");
  if (fields["schema"] !== POLICY_SCHEMA) fail(`schema must be ${POLICY_SCHEMA}`);
  const id = text(fields["id"], "id", 1, 64);
  if (!/^[a-z][a-z0-9-]*$/u.test(id)) fail("id must be lowercase letters, digits, and hyphens, starting with a letter");
  const hypothesis = text(fields["hypothesis"], "hypothesis", 10, 500);
  const project = text(fields["project"], "project", 1, 32);
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(project)) fail("project must be a project id such as stats");
  if (fields["operation"] === "cleanup.retention") fail("operation cleanup.retention cannot be verified: its expired count is the rows written by expiry deletes, index rows included, so rowsWrittenPerUnit would compare rows written to itself");
  const operation = oneOf(fields["operation"], [...COMPARABLE_OPERATIONS, "global"] as const, "operation");
  const direction = oneOf(fields["direction"], ["decrease", "increase"] as const, "direction");
  const minChangePercent = number(fields["minChangePercent"], "minChangePercent");
  if (minChangePercent < MIN_CHANGE_PERCENT) fail(`minChangePercent must be at least ${MIN_CHANGE_PERCENT}; a lower bar is not evidence`);
  if (minChangePercent > 1000) fail("minChangePercent must be at most 1000");
  const window = oneOf(fields["window"], Object.keys(COMPARISON_WINDOWS) as ComparisonWindow[], "window");
  const maxWaitMs = fields["maxWaitMs"];
  if (typeof maxWaitMs !== "number" || !Number.isInteger(maxWaitMs) || maxWaitMs < MIN_WAIT_MS || maxWaitMs > MAX_WAIT_MS) fail(`maxWaitMs must be an integer from ${MIN_WAIT_MS} to ${MAX_WAIT_MS}`);

  const metric = text(fields["metric"], "metric", 1, 96);
  if (operation !== "global" && !(OPERATION_METRICS as readonly string[]).includes(metric)) fail(`metric for ${operation} must be one of ${OPERATION_METRICS.join(", ")}`);
  const minimum = defaultFloor(operation, metric);
  if (minimum === undefined) fail(`metric ${metric} is not a global comparison metric (worker.cpu, worker.errors, do.cpu, do.wall, d1.read, d1.write, cost, r2.<bucket>, probe.<name>.ms, probe.<name>.failure)`);
  const floor = number(fields["floor"], "floor");
  if (floor < minimum) fail(`floor for ${metric} must be at least its default ${minimum}`);

  const workloadClass = fields["workloadClass"] === null ? undefined : fields["workloadClass"];
  const classed = CLASSED_OPERATIONS.includes(operation as ComparableOperation);
  if (classed && workloadClass === undefined) fail(`${operation} needs a workloadClass`);
  if (!classed && workloadClass !== undefined) fail(`${operation} has no workload classes; remove workloadClass`);

  const listed = fields["guardrails"];
  if (!Array.isArray(listed)) fail("guardrails must be a list");
  const guardrails = listed.map((item, index) => oneOf(item, GUARDRAIL_IDS, `guardrails[${index}]`));
  if (new Set(guardrails).size !== guardrails.length) fail("guardrails must not repeat");
  const applicable = applicableGuardrails(operation);
  for (const id of guardrails) if (!applicable.includes(id)) fail(`guardrail ${id} does not apply to ${operation}`);
  const waivedGuardrails = parseWaivers(fields["waivedGuardrails"]);
  if (new Set(waivedGuardrails.map(item => item.guardrail)).size !== waivedGuardrails.length) fail("waivedGuardrails must not repeat");
  for (const { guardrail } of waivedGuardrails) {
    if (guardrails.includes(guardrail)) fail(`${guardrail} is both listed and waived`);
    if (!applicable.includes(guardrail)) fail(`guardrail ${guardrail} does not apply to ${operation}`);
  }
  for (const required of UNWAIVABLE) if (!guardrails.includes(required)) fail(`guardrails must include ${required}`);
  for (const id of applicable) if (!guardrails.includes(id) && !waivedGuardrails.some(item => item.guardrail === id)) fail(`guardrail ${id} is required: list it, or waive it with a reason`);

  const common = { schema: POLICY_SCHEMA, id, hypothesis, project, direction, minChangePercent, floor, guardrails: applicable.filter(item => guardrails.includes(item)), waivedGuardrails, window, maxWaitMs } as const;
  if (operation === "global") return { ...common, operation, workloadClass: null, metric };
  const operationMetric = oneOf(metric, OPERATION_METRICS, "metric");
  if (operation === "host.history" || operation === "project.history") return { ...common, operation, workloadClass: text(workloadClass, "workloadClass", 1, 128), metric: operationMetric };
  return { ...common, operation, workloadClass: null, metric: operationMetric };
}

export function parsePolicyText(source: string): Policy {
  if (new TextEncoder().encode(source).byteLength > MAX_POLICY_BYTES) fail(`the policy is larger than ${MAX_POLICY_BYTES} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    fail("the policy is not valid JSON");
  }
  return parsePolicy(parsed);
}

export function policyHash(policy: Policy): string {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

export interface ServicePolicy {
  readonly schema: typeof POLICY_SCHEMA;
  readonly id: string;
  readonly hypothesis: string;
  readonly service: string;
  readonly metric: string;
  readonly direction: "decrease" | "increase";
  readonly minChangePercent: number;
  readonly floor: number;
  readonly window: ComparisonWindow;
}

const SERVICE_POLICY_FIELDS = ["schema", "id", "hypothesis", "service", "metric", "direction", "minChangePercent", "floor", "window"];

export function parseServicePolicyText(source: string): ServicePolicy {
  if (new TextEncoder().encode(source).byteLength > MAX_POLICY_BYTES) fail(`the policy is larger than ${MAX_POLICY_BYTES} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    fail("the policy is not valid JSON");
  }
  const fields = record(parsed, "the policy");
  noUnknown(fields, SERVICE_POLICY_FIELDS, "the policy");
  if (fields["schema"] !== POLICY_SCHEMA) fail(`schema must be ${POLICY_SCHEMA}`);
  const id = text(fields["id"], "id", 1, 64);
  if (!/^[a-z][a-z0-9-]*$/u.test(id)) fail("id must be lowercase letters, digits, and hyphens, starting with a letter");
  const hypothesis = text(fields["hypothesis"], "hypothesis", 10, 500);
  const service = text(fields["service"], "service", 1, 32);
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(service)) fail("service must be a service name such as stats-node");
  const metric = oneOf(fields["metric"], SERVICE_LEVEL_METRICS.map(entry => entry.metric), "metric");
  const direction = oneOf(fields["direction"], ["decrease", "increase"] as const, "direction");
  const minChangePercent = number(fields["minChangePercent"], "minChangePercent");
  if (minChangePercent < MIN_CHANGE_PERCENT) fail(`minChangePercent must be at least ${MIN_CHANGE_PERCENT}; a lower bar is not evidence`);
  if (minChangePercent > 1000) fail("minChangePercent must be at most 1000");
  const window = oneOf(fields["window"], Object.keys(COMPARISON_WINDOWS) as ComparisonWindow[], "window");
  const minimum = SERVICE_LEVEL_METRICS.find(entry => entry.metric === metric)!.floor;
  const floor = number(fields["floor"], "floor");
  if (floor < minimum) fail(`floor for ${metric} must be at least its default ${minimum}`);
  return { schema: POLICY_SCHEMA, id, hypothesis, service, metric, direction, minChangePercent, floor, window };
}
