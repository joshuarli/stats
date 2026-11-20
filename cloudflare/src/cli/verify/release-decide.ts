import type { ReleaseEvidence } from "./release-evidence.ts";

type Status = "pass" | "reject" | "inconclusive" | "pending";
type Reason = { code: string; gate: string; message: string };
const rank: Record<Status, number> = { pass: 0, pending: 1, inconclusive: 2, reject: 3 };

export function decideRelease(evidence: ReleaseEvidence, nowMs: number) {
  const { policy: p, ledger, observations } = evidence;
  const gates: Record<string, Status> = Object.fromEntries(["correctness", "durability", "identity", "delivery", "evidence", "limits", "recovery"].map(name => [name, "pass"]));
  const reasons: Reason[] = [];
  function add(gate: string, status: Status, code: string, message: string): void {
    if (rank[status] > rank[gates[gate]!]) gates[gate] = status;
    reasons.push({ gate, code, message });
  }
  const start = p.windows.startMs + p.windows.warmupMs;
  const end = start + p.windows.measureMs;
  if (!Number.isSafeInteger(end) || p.windows.measureMs === 0 || p.minimums.requests === 0 || p.minimums.measureMs === 0 || p.requiredSources.length === 0 || p.absolute.maxErrorShare > 1 || p.histogramMaxRelativeError >= 1) add("evidence", "inconclusive", "invalid-policy", "policy requires a bounded measurement window, requests and sources");
  if (nowMs < end) add("evidence", "pending", "window-open", "measurement window has not ended");
  if (p.baselineRelease !== evidence.baseline.releaseId || p.candidateRelease !== evidence.candidate.releaseId || p.baselineRelease === p.candidateRelease || p.workloadId !== evidence.workload.id || p.workloadSha256 !== evidence.hashes["workload.json"]) add("identity", "inconclusive", "policy-identity", "policy and bundle identities do not agree");
  const policySufficient = reasons.length === 0;
  const percentile = (side: "baseline" | "candidate", fraction: number): number | null => {
    const l = ledger[side]; let total = 0; let previous = -1;
    for (const [bound, count] of l.histogram.buckets) { if (bound <= previous || count === 0) return null; previous = bound; total += count; }
    if (!Number.isSafeInteger(total) || total !== l.attempted || total === 0 || l.histogram.relativeError > p.histogramMaxRelativeError || l.histogram.relativeError >= 1) return null;
    let seen = 0;
    for (const [bound, count] of l.histogram.buckets) { seen += count; if (seen >= Math.ceil(total * fraction)) return bound / 1000; }
    return null;
  };
  const sufficient = { baseline: policySufficient, candidate: policySufficient };
  const metrics: Record<"baseline" | "candidate", Record<string, number | null>> = { baseline: {}, candidate: {} };
  for (const side of ["baseline", "candidate"] as const) {
    const reasonStart = reasons.length;
    const l = ledger[side], o = observations[side], expected = evidence[side].releaseId;
    const defect: Status = side === "candidate" ? "reject" : "inconclusive";
    if (l.releaseId !== expected || l.workloadId !== p.workloadId || o.sources.some(s => s.releaseId !== expected)) add("identity", defect, "mixed-release", `${side} contains a mismatched release or workload`);
    if (l.windowStartMs !== start || l.windowEndMs !== end) add("identity", "inconclusive", "window-mismatch", `${side} ledger does not match the policy window`);
    if (l.attempted < p.minimums.requests) add("evidence", nowMs < end ? "pending" : "inconclusive", "requests-insufficient", `${side} has too few requests`);
    if (l.windowEndMs - l.windowStartMs < p.minimums.measureMs) add("evidence", nowMs < end ? "pending" : "inconclusive", "duration-insufficient", `${side} measurement is too short`);
    if (o.resources.cpuSeconds === null || o.resources.memoryPeakBytes === null || o.resources.restarts === null) add("evidence", "inconclusive", "resources-missing", `${side} resources are unavailable`);
    if (!l.history.phases.some(phase => phase.phase === "before") || !l.history.phases.some(phase => phase.phase === "after") || l.history.phases.some(phase => phase.expected !== l.history.samples.length) || l.history.samples.length === 0) add("evidence", "inconclusive", "history-incomplete", `${side} history phases are incomplete`);
    const historyIdentities = new Set(l.history.samples.map(entry => `${entry.host}\0${entry.sample.atMs}`));
    if (historyIdentities.size !== l.history.samples.length) add("evidence", "inconclusive", "history-incomplete", `${side} history identities are duplicated`);
    for (const phase of l.history.phases) {
      if (phase.expected !== phase.verified + phase.missing + phase.mismatched) add("evidence", "inconclusive", "history-incomplete", `${side} history counts are inconsistent`);
      if (phase.missing + phase.mismatched > 0) add("durability", "reject", "history-mismatch", `${side} ${phase.phase} history differs`);
    }
    if (l.truncated || o.truncated) add("evidence", "inconclusive", "truncated", `${side} evidence is truncated`);
    if (o.observer.status !== "ok") add("evidence", "inconclusive", "observer-failed", `${side} observer failed`);
    if (o.hostConfounded) add("evidence", "inconclusive", "host-confounded", `${side} host load is confounded`);
    if (o.observer.checkedAtMs > nowMs || nowMs - o.observer.checkedAtMs > p.maxEvidenceAgeMs) add("evidence", "inconclusive", "stale-evidence", `${side} observer evidence is stale or in the future`);
    const failures = Object.values(l.failures).reduce((a, b) => a + b, 0);
    if (!Number.isSafeInteger(failures) || l.succeeded + failures !== l.attempted || l.bodyMismatches > l.succeeded || l.readbackVerified > l.acknowledgedWrites || l.lostWrites > l.acknowledgedWrites) add("correctness", "inconclusive", "ledger-inconsistent", `${side} ledger counts are inconsistent`);
    if (l.bodyMismatches > 0) add("correctness", defect, "body-mismatch", `${side} returned incorrect response bodies`);
    if (l.readbackVerified + l.lostWrites !== l.acknowledgedWrites) add("durability", "inconclusive", "readback-incomplete", `${side} acknowledged writes lack readback`);
    if (l.lostWrites > (side === "candidate" ? p.absolute.maxLostWrites : 0)) add("durability", defect, "lost-writes", `${side} lost acknowledged writes`);
    if (l.duplicateMismatches > 0) add("durability", defect, "duplicate-mismatch", `${side} duplicate writes differed`);
    const seen = new Set<string>();
    for (const s of o.sources) {
      const key = `${s.source}\0${s.producer}`;
      if (seen.has(key)) add("delivery", "inconclusive", "duplicate-source", `${side} has duplicate source records`);
      seen.add(key);
      if (s.lastSeenMs > nowMs || nowMs - s.lastSeenMs > p.maxEvidenceAgeMs) add("evidence", "inconclusive", "stale-evidence", `${side} source ${s.source}/${s.producer} is stale or in the future`);
      const first = s.sequenceStart, last = s.sequenceEnd;
      if (first.startedAtMs !== last.startedAtMs || first.atMs > start || last.atMs < first.atMs || last.atMs > s.lastSeenMs || s.lastSeenMs > o.observer.checkedAtMs || last.accepted < first.accepted || s.received !== last.accepted - first.accepted || last.dropped !== first.dropped || first.queued !== 0 || last.queued !== 0) add("delivery", "inconclusive", "delivery-incomplete", `${side} source ${s.source}/${s.producer} does not prove complete delivery`);
      if (last.atMs < end) add("delivery", nowMs < end ? "pending" : "inconclusive", "delivery-window", `${side} source ${s.source}/${s.producer} has not covered the window`);
    }
    for (const required of p.requiredSources) {
      const found = o.sources.find(s => s.source === required.source && s.producer === required.producer);
      if (!found) add("delivery", nowMs < end ? "pending" : "inconclusive", "source-missing", `${side} source ${required.source}/${required.producer} did not report`);
      else for (const name of required.families) {
        const family = found.families?.[name];
        if (!family || !family.usable || family.okSamples === 0 || family.reason !== null) add("delivery", nowMs < end && (!family || family.reason === "window-open") ? "pending" : "inconclusive", family?.reason ?? "family-missing", `${side} source ${required.source} family ${name} is unusable`);
      }
    }
    const p95 = percentile(side, 0.95), p99 = percentile(side, 0.99);
    if (p95 === null || p99 === null) add("limits", nowMs < end && l.attempted < p.minimums.requests ? "pending" : "inconclusive", "histogram-unusable", `${side} histogram is incomplete or too coarse`);
    const errorShare = l.attempted === 0 ? null : (failures + l.bodyMismatches) / l.attempted;
    metrics[side] = { p95Ms: p95, p99Ms: p99, cpuSeconds: o.resources.cpuSeconds, cpuPerK: o.resources.cpuSeconds === null || l.attempted === 0 ? null : o.resources.cpuSeconds * 1000 / l.attempted, memoryPeakBytes: o.resources.memoryPeakBytes, errorShare };
    sufficient[side] = policySufficient && reasons.slice(reasonStart).length === 0;
    if (side === "candidate") {
      if (errorShare !== null && errorShare > p.absolute.maxErrorShare) add("limits", "reject", "error-share", "candidate error share exceeded its limit");
      if (p95 !== null && p95 > p.absolute.p95Ms) add("limits", "reject", "latency-p95", "candidate p95 exceeded its absolute limit");
      if (p99 !== null && p99 > p.absolute.p99Ms) add("limits", "reject", "latency-p99", "candidate p99 exceeded its absolute limit");
      if (o.resources.cpuSeconds !== null && l.attempted > 0 && o.resources.cpuSeconds * 1000 / l.attempted > p.absolute.maxCpuSecondsPerKRequests) add("limits", "reject", "cpu-limit", "candidate CPU exceeded its absolute limit");
      if (o.resources.memoryPeakBytes !== null && o.resources.memoryPeakBytes > p.absolute.maxMemoryPeakBytes) add("limits", "reject", "memory-limit", "candidate memory exceeded its absolute limit");
      if (o.resources.restarts !== null && o.resources.restarts > p.absolute.maxRestarts) add("limits", "reject", "restarts", "candidate restarts exceeded the limit");
    }
  }
  const relativeExceeded = (before: number, after: number, limit: number) => after > before && (before === 0 || (after - before) / before * 100 > limit);
  for (const name of ["p95Ms", "p99Ms"] as const) {
    const before = metrics.baseline[name], after = metrics.candidate[name];
    if (sufficient.baseline && sufficient.candidate && before != null && after != null && relativeExceeded(before, after, p.regression.latency.maxRelativeIncreasePercent) && after - before > p.regression.latency.absoluteFloorMs) add("limits", "reject", `latency-${name.slice(0, 3)}`, `candidate ${name} exceeded the latency limit`);
  }
  for (const [name, limit] of [["cpuPerK", p.regression.maxCpuRelativeIncreasePercent], ["memoryPeakBytes", p.regression.maxMemoryRelativeIncreasePercent]] as const) {
    const before = metrics.baseline[name]!, after = metrics.candidate[name]!;
    if (sufficient.baseline && sufficient.candidate && before != null && after != null && relativeExceeded(before, after, limit)) add("limits", "reject", name === "cpuPerK" ? "cpu-regression" : "memory-regression", `candidate ${name} exceeded the relative limit`);
  }
  const recovery = evidence.recovery;
  if (recovery === null || !recovery.readbackVerified || recovery.method !== p.recovery.method || recovery.previousRelease !== evidence.baseline.releaseId || recovery.verifiedAtMs > nowMs || nowMs - recovery.verifiedAtMs > p.maxEvidenceAgeMs) add("recovery", "inconclusive", "recovery-unverified", "recovery of the previous release is not verified with fresh evidence");
  let improvement: "improved" | "unchanged" | "regressed" | "not-claimed" | "insufficient-data" = "not-claimed";
  if (p.improvement !== undefined) {
    const before = metrics.baseline[p.improvement.metric], after = metrics.candidate[p.improvement.metric];
    if (before == null || after == null || before === 0 || gates.evidence !== "pass" || gates.delivery !== "pass" || gates.identity !== "pass" || gates.limits === "inconclusive") improvement = "insufficient-data";
    else { const change = (after - before) / before * 100 * (p.improvement.direction === "increase" ? 1 : -1); improvement = Math.abs(change) < p.improvement.minChangePercent ? "unchanged" : change > 0 ? "improved" : "regressed"; }
  }
  const verdict = Object.values(gates).reduce<Status>((a, b) => rank[b] > rank[a] ? b : a, "pass");
  return { kind: "release-verdict" as const, policy: p.id, baselineRelease: evidence.baseline.releaseId, candidateRelease: evidence.candidate.releaseId, workloadSha256: p.workloadSha256, verdict, gates, reasons, improvement, evaluatedAtMs: nowMs, hashes: evidence.hashes };
}
