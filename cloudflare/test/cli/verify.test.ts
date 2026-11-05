import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandError, EXIT } from "../../src/cli/exit.ts";
import type { VerdictPayload } from "../../src/cli/commands/verify.ts";
import { AT, bounds, CANDIDATE, deployment, harness, id, newWorld, POLICY, READY_AT, H, type Harness, type World } from "./verify-support.ts";

type Result = Awaited<ReturnType<Harness["run"]>>["result"];
const verdictOf = (result: Result) => result.payload as VerdictPayload;
const guardrail = (result: Result, name: string) => verdictOf(result).decision?.guardrails.find(item => item.id === name);

async function scenario(world: World, options: Record<string, string | boolean> = {}, policy: Record<string, unknown> = POLICY, safety: Parameters<Harness["safetyFile"]>[0] | null = {}): Promise<{ h: Harness; result: Result }> {
  const h = await harness(world, policy);
  const withSafety = safety === null ? options : { "safety-check-file": h.safetyFile(safety), ...options };
  try {
    const { result } = await h.run({ deployment: CANDIDATE.id, ...withSafety });
    return { h, result };
  } catch (error) {
    await h.close();
    throw error;
  }
}

async function verdictFor(world: World, options: Record<string, string | boolean> = {}, policy: Record<string, unknown> = POLICY, safety: Parameters<Harness["safetyFile"]>[0] | null = {}): Promise<Result> {
  const { h, result } = await scenario(world, options, policy, safety);
  await h.close();
  return result;
}

await test("a clean cost win with every guardrail passing is improved, reads exact bounds, and stays inside one poll budget", async () => {
  const { h, result } = await scenario(newWorld());
  try {
    const payload = verdictOf(result);
    assert.equal(result.exit, EXIT.ok, JSON.stringify(payload.reasons));
    assert.equal(payload.verdict, "improved");
    assert.equal(payload.decision?.target.before, 3);
    assert.equal(payload.decision?.target.after, 1.5);
    assert.deepEqual(payload.decision?.guardrails.map(item => item.status).sort(), ["not-applicable", "pass", "pass", "pass", "pass", "pass"]);
    const urls = h.origin.seen.map(seen => seen.url);
    assert.ok(urls.includes(`/api/observe/stats/window?from=${bounds.before.fromMs}&to=${bounds.before.toMs}&operation=host.ingest`));
    assert.ok(urls.includes(`/api/observe/stats/window?from=${bounds.after.fromMs}&to=${bounds.after.toMs}&operation=host.ingest`));
    assert.ok(urls.length <= 6, urls.join("\n"));
    assert.equal(payload.overhead.requests, urls.length);
    assert.ok(existsSync(payload.state.path));
  } finally {
    await h.close();
  }
});

await test("overlap, a split rollout, and a deferred rollout are confounded even when the cost fell", async () => {
  const cases: [string, World][] = [
    ["overlap", newWorld({ deployments: [deployment(1, AT - 2 * H, 101), CANDIDATE, deployment(3, AT + 20 * 60_000, 103)] })],
    ["split", newWorld({ deployments: [deployment(1, AT - 2 * H, 101), deployment(2, AT, 102, { versions: [{ id: id(102), percentage: 50 }, { id: id(103), percentage: 50 }] })] })],
    ["deferred", newWorld({ deployments: [deployment(1, AT - 2 * H, 101), deployment(2, AT, 102, { deferred: true })] })]
  ];
  for (const [name, world] of cases) {
    const { h, result } = await scenario(world);
    try {
      assert.equal(verdictOf(result).verdict, "confounded", name);
      assert.equal(result.exit, EXIT.unchanged, name);
      assert.ok(h.origin.seen.length <= 6, name);
    } finally {
      await h.close();
    }
  }
});

await test("a workload shift beyond 2x is confounded", async () => {
  const result = await verdictFor(newWorld({ after: { rowsWritten: 300, work: { persisted: 700 } } }));
  assert.equal(verdictOf(result).verdict, "confounded");
  assert.ok(verdictOf(result).decision?.blockedBy.includes("work-drift"));
});

await test("too few operations is insufficient-data, never a pass", async () => {
  const result = await verdictFor(newWorld({ before: { rowsWritten: 600, count: 5 }, after: { rowsWritten: 300, count: 5 } }));
  assert.equal(verdictOf(result).verdict, "insufficient-data");
  assert.equal(result.exit, EXIT.pending);
  assert.equal(guardrail(result, "failed-share")?.status, "insufficient-data");
});

await test("an effect below the policy bar is unchanged and exits 6", async () => {
  const result = await verdictFor(newWorld({ after: { rowsWritten: 590 } }));
  assert.equal(verdictOf(result).verdict, "unchanged");
  assert.equal(result.exit, EXIT.unchanged);
});

await test("a guardrail without evidence never passes, whatever the cost did", async () => {
  const noSafety = await verdictFor(newWorld(), {}, POLICY, null);
  assert.equal(verdictOf(noSafety).verdict, "insufficient-data");
  assert.equal(guardrail(noSafety, "safety-check")?.status, "insufficient-data");
  const early = await verdictFor(newWorld(), {}, POLICY, { atMs: AT - 3 * H });
  assert.equal(verdictOf(early).verdict, "insufficient-data");
  const partial = await verdictFor(newWorld({ observedFactor: 0.5 }));
  assert.equal(verdictOf(partial).verdict, "insufficient-data");
  assert.equal(guardrail(partial, "coverage")?.status, "insufficient-data");
  const probeRows = (up: number) => [bounds.before, bounds.after].flatMap((side, index) => Array.from({ length: 12 }, (_, bucket) => [{ metric: "probe.health.up", bucket_ms: side.fromMs + bucket * 300_000, value: index === 0 ? 1 : up }, { metric: "probe.health.ms", bucket_ms: side.fromMs + bucket * 300_000, value: 50 }]).flat());
  const noProbeData = await verdictFor(newWorld({ probes: ["health"] }));
  assert.equal(guardrail(noProbeData, "probe-failure-share")?.status, "insufficient-data");
  assert.equal(verdictOf(noProbeData).verdict, "insufficient-data");
  const probeUp = await verdictFor(newWorld({ probes: ["health"], probeRows: probeRows(1) }));
  assert.equal(verdictOf(probeUp).verdict, "improved");
  const probeDown = await verdictFor(newWorld({ probes: ["health"], probeRows: probeRows(0.9) }));
  assert.equal(guardrail(probeDown, "probe-failure-share")?.status, "regressed");
  assert.equal(verdictOf(probeDown).verdict, "regressed");
});

await test("a regressed guardrail overrides a cost win", async () => {
  const failed = await verdictFor(newWorld({ after: { rowsWritten: 300, failed: 1 } }));
  assert.equal(verdictOf(failed).verdict, "regressed");
  assert.equal(failed.exit, EXIT.regressed);
  const issue = await verdictFor(newWorld({ issues: { [id(102)]: 1 } }));
  assert.equal(guardrail(issue, "new-issue-group")?.status, "regressed");
  assert.equal(issue.exit, EXIT.regressed);
  const persistence = await verdictFor(newWorld({ after: { rowsWritten: 300, work: { persisted: 150 } } }));
  assert.equal(guardrail(persistence, "ingest-persistence")?.status, "regressed");
  assert.equal(persistence.exit, EXIT.regressed);
  const failedCheck = await verdictFor(newWorld(), {}, POLICY, { ok: false, failedStep: "replay" });
  assert.equal(verdictOf(failedCheck).verdict, "regressed");
});

await test("a failed safety check regresses at once, even before the window is ready", async () => {
  const world = newWorld();
  world.clock.now = AT + 30 * 60_000;
  const result = await verdictFor(world, {}, POLICY, { ok: false, failedStep: "ingest" });
  assert.equal(verdictOf(result).verdict, "regressed");
  assert.equal(result.exit, EXIT.regressed);
});

await test("the wrong-way target move is regressed and the right-way move below the bar is not improved", async () => {
  const worse = await verdictFor(newWorld({ after: { rowsWritten: 900 } }));
  assert.equal(verdictOf(worse).verdict, "regressed");
  const increase = await verdictFor(newWorld({ after: { rowsWritten: 900 } }), {}, { ...POLICY, direction: "increase" });
  assert.equal(verdictOf(increase).verdict, "improved");
});

await test("a waived guardrail is reported as waived and no longer blocks", async () => {
  const guardrails = POLICY.guardrails.filter(name => name !== "new-issue-group");
  const result = await verdictFor(newWorld({ issues: { [id(102)]: 2 } }), {}, { ...POLICY, guardrails, waivedGuardrails: [{ guardrail: "new-issue-group", reason: "the candidate adds a known noisy log path" }] });
  assert.equal(verdictOf(result).verdict, "improved");
  assert.equal(guardrail(result, "new-issue-group")?.status, "waived");
});

await test("delayed settlement is pending, sleeps to readyAtMs before reading data, then resolves after polls", async () => {
  const world = newWorld({ settled: false });
  world.clock.now = AT + 30 * 60_000;
  const start = world.clock.now;
  const h = await harness(world);
  try {
    const seenAtSleep: number[] = [];
    const { result } = await h.run({ deployment: CANDIDATE.id, wait: true, timeout: "30h", "safety-check-file": h.safetyFile({}) }, {
      onSleep: () => { seenAtSleep.push(h.origin.seen.length); if (h.sleeps.length === 3) world.settled = true; }
    });
    assert.equal(verdictOf(result).verdict, "improved");
    assert.equal(result.exit, EXIT.ok);
    assert.equal(h.sleeps[0], READY_AT - start);
    assert.deepEqual(h.sleeps.slice(1), [900_000, 900_000]);
    assert.equal(seenAtSleep[0], 1);
    assert.equal(h.origin.seen.slice(0, 1).every(seen => seen.url.includes("/comparison")), true);
    assert.equal(verdictOf(result).overhead.polls, 4);
  } finally {
    await h.close();
  }
});

await test("a timeout is pending, exits 5, and prints the exact resume command", async () => {
  const world = newWorld({ settled: false });
  world.clock.now = AT + 30 * 60_000;
  const h = await harness(world);
  try {
    const safety = h.safetyFile({});
    const { result } = await h.run({ deployment: "latest", wait: true, timeout: "10m", json: true, "safety-check-file": safety });
    const payload = verdictOf(result);
    assert.equal(payload.verdict, "pending");
    assert.equal(result.exit, EXIT.pending);
    assert.equal(payload.wait.timedOut, true);
    assert.equal(h.sleeps.length, 0);
    assert.equal(payload.wait.resume, `pnpm --dir cloudflare -s statsctl verify --project stats --deployment ${CANDIDATE.id} --window 1h --policy ${h.policyFile} --safety-check-file ${safety} --origin ${h.origin.origin} --wait --timeout 10m --json`);
  } finally {
    await h.close();
  }
});

await test("SIGINT during a wait saves state and exits 5; the resume continues from state without resolving latest again", async () => {
  const world = newWorld({ settled: false });
  world.clock.now = AT + 30 * 60_000;
  const h = await harness(world);
  try {
    const safety = h.safetyFile({});
    const controller = new AbortController();
    const first = (await h.run({ deployment: "latest", wait: true, timeout: "30h", "safety-check-file": safety }, { signal: controller.signal, onSleep: () => controller.abort() })).result;
    const interrupted = verdictOf(first);
    assert.equal(first.exit, EXIT.pending);
    assert.equal(interrupted.wait.interrupted, true);
    assert.match(interrupted.wait.resume ?? "", new RegExp(`--deployment ${CANDIDATE.id} .*--wait`, "u"));
    const state = JSON.parse(readFileSync(interrupted.state.path, "utf8")) as { polls: number; requests: number; requested: string };
    assert.equal(state.polls, 1);
    assert.equal(state.requested, "latest");
    const listings = () => h.origin.seen.filter(seen => seen.url === "/api/v1/projects/stats/deployments").length;
    assert.equal(listings(), 1);

    world.settled = true;
    const second = (await h.run({ deployment: CANDIDATE.id, wait: true, timeout: "30h", "safety-check-file": safety })).result;
    assert.equal(verdictOf(second).verdict, "improved");
    assert.equal(listings(), 1);
    assert.equal(verdictOf(second).overhead.polls, 3);
    assert.equal(verdictOf(second).overhead.requests, h.origin.seen.length);
  } finally {
    await h.close();
  }
});

await test("the request budget holds: 60 in all, with the cap reported instead of exceeded", async () => {
  const world = newWorld({ settled: false });
  world.clock.now = AT + 30 * 60_000;
  const h = await harness(world);
  try {
    const { result } = await h.run({ deployment: CANDIDATE.id, wait: true, timeout: "7d", "safety-check-file": h.safetyFile({}) });
    const payload = verdictOf(result);
    assert.equal(result.exit, EXIT.pending);
    assert.equal(h.origin.seen.length, 60);
    assert.equal(payload.overhead.requests, 60);
    assert.ok(payload.reasons.some(reason => reason.code === "request-budget"));
    assert.notEqual(payload.verdict, "improved");
    const again = (await h.run({ deployment: CANDIDATE.id, wait: true, timeout: "7d", "safety-check-file": h.safetyFile({}) })).result;
    assert.equal(h.origin.seen.length, 60);
    assert.equal(again.exit, EXIT.pending);
  } finally {
    await h.close();
  }
});

await test("a finished verdict is not re-read, and replay re-derives it offline and rejects a doctored state", async () => {
  const { h, result } = await scenario(newWorld());
  try {
    const payload = verdictOf(result);
    const seen = h.origin.seen.length;
    const repeat = verdictOf((await h.run({ deployment: CANDIDATE.id })).result);
    assert.equal(h.origin.seen.length, seen);
    assert.equal(repeat.state.reusedFinal, true);
    assert.equal(repeat.verdict, "improved");

    const replayed = (await h.run({ replay: payload.state.path })).result;
    assert.equal(h.origin.seen.length, seen);
    assert.equal(replayed.exit, EXIT.ok);
    const again = verdictOf(replayed);
    assert.deepEqual(again.replay, { file: payload.state.path, reproduced: true });
    assert.deepEqual(again.decision?.target, payload.decision?.target);
    assert.deepEqual(again.decision?.guardrails, payload.decision?.guardrails);

    const doctored = JSON.parse(readFileSync(payload.state.path, "utf8")) as { last: { verdict: string } };
    doctored.last.verdict = "regressed";
    const copy = join(h.directory, "doctored.json");
    writeFileSync(copy, JSON.stringify(doctored));
    await assert.rejects(h.run({ replay: copy }), (error: unknown) => error instanceof CommandError && error.code === "replay_mismatch" && error.exit === EXIT.transport);
    const strange = JSON.parse(readFileSync(payload.state.path, "utf8")) as { policyHash: string };
    strange.policyHash = "0".repeat(64);
    writeFileSync(copy, JSON.stringify(strange));
    await assert.rejects(h.run({ replay: copy }), (error: unknown) => error instanceof CommandError && error.code === "state_invalid");
  } finally {
    await h.close();
  }
});

await test("a state for another policy is refused rather than reused", async () => {
  const { h } = await scenario(newWorld(), {}, POLICY);
  try {
    writeFileSync(h.policyFile, JSON.stringify({ ...POLICY, minChangePercent: 20 }));
    await assert.rejects(h.run({ deployment: CANDIDATE.id }), (error: unknown) => error instanceof CommandError && error.exit === EXIT.usage && /different policy/u.test(error.message));
    await assert.rejects(h.run({ deployment: CANDIDATE.id, window: "6h" }), (error: unknown) => error instanceof CommandError && error.exit === EXIT.usage && /pre-registered window/u.test(error.message));
  } finally {
    await h.close();
  }
});

await test("readiness lists each needed signal, flags absent operation summaries, and exits 5 until all are available", async () => {
  const absent = newWorld({ operationRows: false });
  const h = await harness(absent);
  try {
    const { result } = await h.run({ deployment: CANDIDATE.id, readiness: true });
    const payload = result.payload as { ready: boolean; signals: { signal: string; status: string; message: string }[] };
    assert.equal(result.exit, EXIT.pending);
    assert.equal(payload.ready, false);
    const summaries = payload.signals.find(signal => signal.signal === "operation-summaries");
    assert.equal(summaries?.status, "unavailable:no_operation_summaries");
    assert.match(summaries?.message ?? "", /operation summaries absent for host\.ingest/u);
    assert.equal(payload.signals.find(signal => signal.signal === "safety-check")?.status, "unavailable:safety_check_missing");
    assert.deepEqual(payload.signals.map(signal => signal.signal), ["analytics-collector", "deployment-comparison", "observe-events", "observe-invocations", "operation-summaries", "probes", "safety-check"]);
    assert.ok(h.origin.seen.length <= 6);

    absent.operationRows = true;
    const ready = (await h.run({ deployment: CANDIDATE.id, readiness: true, "safety-check-file": h.safetyFile({}) })).result;
    assert.equal(ready.exit, EXIT.ok);
    assert.equal((ready.payload as { ready: boolean }).ready, true);
  } finally {
    await h.close();
  }
});
