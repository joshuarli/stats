import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { startStack, type Stack } from "./canary/stack.mts";
import { faultProxy } from "./canary/fault-proxy.mts";
import { prepare, runWorkload } from "./canary/workload.mts";
import { observe, recover, monitorResources, source, waitCheckpoint, writeBundle } from "./canary/evidence.mts";

await test("isolated canaries produce replayable pass, body mismatch and missing source decisions", { timeout: 1_200_000 }, async () => {
  const root = mkdtempSync(resolve(".work/tmp/canary-pair-"));
  try {
    const closure = join(root, "closure"); mkdirSync(closure);
    for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) cpSync(resolve("deploy/orange", name), join(closure, name));
    const install = spawnSync("docker", ["run", "--rm", "-v", `${closure}:/work`, "-w", "/work", "node@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5", "sh", "-ec", "npm install -g pnpm@12.21.0 >/dev/null && pnpm install --frozen-lockfile --prod --ignore-scripts"], { encoding: "utf8", timeout: 120_000 });
    assert.equal(install.status, 0, install.stderr);
    for (const mode of ["normal", "body", "missing", "missing-history", "corrupt-history"] as const) {
      let baseline: Stack | undefined, candidate: Stack | undefined;
      let proxy: Awaited<ReturnType<typeof faultProxy>> | undefined;
      try {
        baseline = await startStack(join(root, `${mode}-baseline`), "baseline", false, closure, true);
        candidate = await startStack(join(root, `${mode}-candidate`), "candidate", mode === "missing", closure, true);
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
        const start = Date.now();
        const baselineResources = monitorResources(baseline), candidateResources = monitorResources(candidate);
        if (mode === "body" || mode === "missing-history" || mode === "corrupt-history") proxy = await faultProxy(candidate.origin, mode);
        const [left, right] = await Promise.all([runWorkload(baseline, baselineCredentials, baseline.origin), runWorkload(candidate, candidateCredentials, proxy?.origin ?? candidate.origin)]);
        const leftResources = baselineResources(), rightResources = candidateResources();
        const end = Date.now();
        await fetch(`${baseline.origin}/api/v1/capabilities`, { headers: baseline.headers });
        if (mode !== "missing") await fetch(`${candidate.origin}/api/v1/capabilities`, { headers: candidate.headers });
        const [leftObservation, rightObservation] = await Promise.all([waitCheckpoint(baseline, from, end), mode === "missing" ? observe(candidate, from) : waitCheckpoint(candidate, from, end)]);
        assert.deepEqual(left.ledger.failures, {});
        assert.deepEqual(right.ledger.failures, {});
        assert.equal(left.ledger.bodyMismatches, 0);
        assert.equal(right.ledger.bodyMismatches, mode === "body" || mode === "missing-history" || mode === "corrupt-history" ? 1 : 0);
        for (const ledger of [left.ledger, right.ledger]) { assert.equal(ledger.attempted, 10); assert.equal(ledger.acknowledgedWrites, 2); assert.equal(ledger.readbackVerified, ledger === right.ledger && (mode === "missing-history" || mode === "corrupt-history") ? 1 : 2); assert.equal(ledger.duplicateMismatches, 0); }
        if (mode === "missing") assert.equal(rightObservation.rows.filter(row => row.event.delivery !== undefined).length, 0);
        const observations = {
          baseline: { observer: { status: "ok", checkedAtMs: leftObservation.checkedAtMs }, sources: [source(leftObservation.rows, baseline.release, start, end)], truncated: leftObservation.truncated, hostConfounded: false, resources: leftResources },
          candidate: { observer: { status: "ok", checkedAtMs: rightObservation.checkedAtMs }, sources: mode === "missing" ? [] : [source(rightObservation.rows, candidate.release, start, end)], truncated: rightObservation.truncated, hostConfounded: false, resources: rightResources }
        };
        await recover(baseline, baseline, join(root, `${mode}-baseline-recovery`), left);
        const recovery = await recover(candidate, baseline, join(root, `${mode}-recovery`), right);
        assert.equal(recovery.readbackVerified, true);
        const bundle = join(root, `${mode}-evidence`);
        const result = writeBundle(bundle, baseline, candidate, { baseline: left.ledger, candidate: right.ledger }, observations, recovery, start, end);
        assert.equal(result.decision.verdict, mode === "normal" ? "pass" : mode === "missing" ? "inconclusive" : "reject", JSON.stringify(result.decision));
        assert.equal(result.status, mode === "normal" ? 0 : mode === "missing" ? 6 : 7);
        if (mode === "body") { assert.equal(proxy!.altered(), true); assert.ok(result.decision.reasons.some((r: {code: string}) => r.code === "body-mismatch")); }
        if (mode === "missing-history" || mode === "corrupt-history") { assert.equal(proxy!.altered(), true); assert.ok(result.decision.reasons.some((r: {code: string}) => r.code === "history-mismatch")); }
        if (mode === "missing") assert.ok(result.decision.reasons.some((r: {code: string}) => r.code === "source-missing"));
        if (mode === "normal") { const retained = mkdtempSync(resolve(".work/tmp/canary-pass-")); cpSync(bundle, retained, { recursive: true }); console.log(`canary pass evidence ${retained}`); }
        const replay = spawnSync("pnpm", ["--dir", "cloudflare", "-s", "statsctl", "verify", "release", "--evidence", bundle, "--replay", "--json"], { encoding: "utf8" });
        assert.equal(replay.status, result.status, replay.stderr);
        assert.equal(JSON.parse(replay.stdout).payload.verdict, result.decision.verdict);
      } finally { await proxy?.stop(); await candidate?.stop(); await baseline?.stop(); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
