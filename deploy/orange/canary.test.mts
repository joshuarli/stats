import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { startStack, type Stack } from "./canary/stack.mts";
import { faultProxy } from "./canary/fault-proxy.mts";
import { prepare, runWorkload } from "./canary/workload.mts";
import { observe, recover, monitorResources, source, waitCheckpoint, writeBundle } from "./canary/evidence.mts";

await test("isolated canaries produce replayable pass, body mismatch and missing source decisions", { timeout: 240_000 }, async () => {
  const root = mkdtempSync(resolve(".work/tmp/canary-pair-"));
  try {
    for (const mode of ["normal", "body", "missing"] as const) {
      let baseline: Stack | undefined, candidate: Stack | undefined;
      let proxy: Awaited<ReturnType<typeof faultProxy>> | undefined;
      try {
        baseline = await startStack(join(root, `${mode}-baseline`), "baseline");
        candidate = await startStack(join(root, `${mode}-candidate`), "candidate", mode === "missing");
        assert.notEqual(baseline.origin, candidate.origin);
        assert.notEqual(baseline.stateDir, candidate.stateDir);
        assert.notDeepEqual(baseline.headers, candidate.headers);
        const from = Date.now() - 60_000;
        const [baselineCredentials, candidateCredentials] = await Promise.all([prepare(baseline), prepare(candidate)]);
        assert.notEqual(baselineCredentials.host.hostId, candidateCredentials.host.hostId);
        assert.notEqual(baselineCredentials.host.token, candidateCredentials.host.token);
        assert.notEqual(baselineCredentials.service.ingestToken, candidateCredentials.service.ingestToken);
        await waitCheckpoint(baseline, from, from);
        if (mode !== "missing") await waitCheckpoint(candidate, from, from);
        const baselineResources = monitorResources(baseline), candidateResources = monitorResources(candidate);
        const start = Date.now() + 1;
        while (Date.now() <= start) await new Promise(resolve => setTimeout(resolve, 5));
        if (mode === "body") proxy = await faultProxy(candidate.origin);
        const [left, right] = await Promise.all([runWorkload(baseline, baselineCredentials, baseline.origin), runWorkload(candidate, candidateCredentials, proxy?.origin ?? candidate.origin)]);
        const end = Date.now();
        await fetch(`${baseline.origin}/api/v1/capabilities`, { headers: baseline.headers });
        if (mode !== "missing") await fetch(`${candidate.origin}/api/v1/capabilities`, { headers: candidate.headers });
        const [leftObservation, rightObservation] = await Promise.all([waitCheckpoint(baseline, from, end), mode === "missing" ? observe(candidate, from) : waitCheckpoint(candidate, from, end)]);
        const leftResources = baselineResources(), rightResources = candidateResources();
        assert.deepEqual(left.ledger.failures, {});
        assert.deepEqual(right.ledger.failures, {});
        assert.equal(left.ledger.bodyMismatches, 0);
        assert.equal(right.ledger.bodyMismatches, mode === "body" ? 1 : 0);
        for (const ledger of [left.ledger, right.ledger]) { assert.equal(ledger.attempted, 10); assert.equal(ledger.acknowledgedWrites, 2); assert.equal(ledger.readbackVerified, 2); assert.equal(ledger.duplicateMismatches, 0); }
        if (mode === "missing") assert.equal(rightObservation.rows.filter(row => row.event.delivery !== undefined).length, 0);
        const observations = {
          baseline: { observer: { status: "ok", checkedAtMs: leftObservation.checkedAtMs }, sources: [source(leftObservation.rows, baseline.release, start, end)], truncated: leftObservation.truncated, hostConfounded: false, resources: leftResources },
          candidate: { observer: { status: "ok", checkedAtMs: rightObservation.checkedAtMs }, sources: mode === "missing" ? [] : [source(rightObservation.rows, candidate.release, start, end)], truncated: rightObservation.truncated, hostConfounded: false, resources: rightResources }
        };
        const recovery = await recover(candidate, baseline, join(root, `${mode}-recovery`), right);
        assert.equal(recovery.readbackVerified, true);
        const bundle = join(root, `${mode}-evidence`);
        const result = writeBundle(bundle, baseline, candidate, { baseline: left.ledger, candidate: right.ledger }, observations, recovery, start, end);
        assert.equal(result.decision.verdict, mode === "normal" ? "pass" : mode === "body" ? "reject" : "inconclusive", JSON.stringify(result.decision));
        assert.equal(result.status, mode === "normal" ? 0 : mode === "body" ? 7 : 6);
        if (mode === "body") { assert.equal(proxy!.altered(), true); assert.ok(result.decision.reasons.some((r: {code: string}) => r.code === "body-mismatch")); }
        if (mode === "missing") assert.ok(result.decision.reasons.some((r: {code: string}) => r.code === "source-missing"));
        const replay = spawnSync("pnpm", ["--dir", "cloudflare", "-s", "statsctl", "verify", "release", "--evidence", bundle, "--replay", "--json"], { encoding: "utf8" });
        assert.equal(replay.status, result.status, replay.stderr);
        assert.equal(JSON.parse(replay.stdout).payload.verdict, result.decision.verdict);
      } finally { await proxy?.stop(); await candidate?.stop(); await baseline?.stop(); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
