import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { parsePolicy, parsePolicyText, policyHash, PolicyError } from "../../src/cli/verify/policy.ts";
import { POLICY } from "./verify-support.ts";

const rejects = (over: Record<string, unknown>, pattern: RegExp) => {
  assert.throws(() => parsePolicy({ ...POLICY, ...over }), (error: unknown) => error instanceof PolicyError && pattern.test(error.message), JSON.stringify(over));
};
const without = (...names: string[]) => POLICY.guardrails.filter(name => !names.includes(name));

await test("the example policy parses and re-parses to the same hash", () => {
  const text = readFileSync(resolve(import.meta.dirname, "../../../bench/policies/example.json"), "utf8");
  const policy = parsePolicyText(text);
  assert.equal(policy.operation, "host.ingest");
  assert.equal(policy.metric, "rowsWrittenPerUnit");
  assert.equal(policy.direction, "decrease");
  assert.equal(policyHash(parsePolicy(JSON.parse(JSON.stringify(policy)))), policyHash(policy));
});

await test("a policy may not lower the bar or hide a guardrail", () => {
  rejects({ minChangePercent: 9.99 }, /at least 10/u);
  rejects({ floor: 0.1 }, /default 0\.5/u);
  rejects({ extra: 1 }, /unknown field extra/u);
  rejects({ operation: "host.ingest", metric: "cpuMsPerUnit", floor: 0.05 }, /default 0\.5/u);
  rejects({ operation: "cleanup.retention", metric: "rowsWrittenPerUnit" }, /cleanup\.retention cannot be verified.*rows written/u);
  rejects({ guardrails: ["safety-check", "coverage", "bogus"] }, /guardrails\[2\]/u);
  rejects({ guardrails: without("safety-check"), waivedGuardrails: [{ guardrail: "safety-check", reason: "it is slow to run" }] }, /never be waived/u);
  rejects({ guardrails: without("coverage"), waivedGuardrails: [{ guardrail: "coverage", reason: "coverage is noisy today" }] }, /never be waived/u);
  rejects({ guardrails: without("coverage") }, /must include coverage/u);
  rejects({ guardrails: without("failed-share") }, /failed-share is required/u);
  rejects({ guardrails: without("failed-share"), waivedGuardrails: [{ guardrail: "failed-share", reason: "short" }] }, /reason/u);
  rejects({ waivedGuardrails: [{ guardrail: "failed-share", reason: "this one is both listed and waived" }] }, /both listed and waived/u);
  rejects({ guardrails: without("failed-share"), waivedGuardrails: [{ guardrail: "failed-share", reason: "a reasoned waiver", extra: true }] }, /unknown field extra/u);
});

await test("scope fields must match the operation", () => {
  rejects({ operation: "host.history", metric: "cpuMsPerUnit" }, /needs a workloadClass/u);
  rejects({ workloadClass: "1h:cpu" }, /no workload classes/u);
  rejects({ metric: "worker.cpu" }, /must be one of/u);
  rejects({ operation: "global", metric: "nonsense", guardrails: without("ingest-persistence") }, /not a global comparison metric/u);
  rejects({ guardrails: [...POLICY.guardrails, "coverage"] }, /must not repeat/u);
  rejects({ operation: "collector.record", metric: "cpuMsPerUnit" }, /does not apply to collector\.record/u);
  rejects({ window: "2h" }, /window must be one of/u);
  rejects({ maxWaitMs: 10 }, /maxWaitMs/u);
  rejects({ schema: "statsctl-policy/2" }, /schema must be/u);
  const global = parsePolicy({ ...POLICY, operation: "global", metric: "do.cpu", floor: 0.1, guardrails: without("ingest-persistence") });
  assert.equal(global.operation, "global");
  const waived = parsePolicy({ ...POLICY, guardrails: without("ingest-persistence"), waivedGuardrails: [{ guardrail: "ingest-persistence", reason: "the host decides what it keeps" }] });
  assert.equal(waived.waivedGuardrails.length, 1);
});
