import { EXIT, transportError, usageError } from "../exit.ts";
import { defineCommand } from "../registry.ts";
import { decideRelease } from "../verify/release-decide.ts";
import { writeReceipt } from "../verify/release-receipt.ts";
import { readReleaseEvidence } from "../verify/release-evidence.ts";

export const verifyReleaseCommand = defineCommand({
  name: "verify release",
  summary: "judge an offline release evidence bundle for promotion",
  description: ["Only pass authorizes promotion. Reads policy.json, baseline.manifest.json, candidate.manifest.json, workload.json, ledger.json, observations.json and recovery.json from the evidence directory. Each ledger and observations file has schema stats-release-evidence/1; the policy uses stats-release-policy/2.", "Source checkpoints are producer delivery snapshots {startedAtMs, atMs, accepted, dropped, queued} that bracket the measurement window; delivery is complete when both belong to one producer session, received equals the accepted difference, dropped is unchanged and both queues are empty. Workload SHA-256 hashes the exact workload.json bytes. The controller records decision.json as {evaluatedAtMs, verdict, reasonCodes}; --replay recomputes at that time and fails on a mismatch.", "--receipt-out creates stats-qualification-receipt/1 with the exact evidence hashes and running bundle hash. It requires the built bundle and a matching decision.json, and refuses an existing output. Unexpected evidence files are invalid.", "Verdict precedence: reject > inconclusive > pending > pass. Exit codes: pass 0, reject 7, inconclusive 6, pending 5; malformed input 2, replay contract mismatch 4. Reasons contain stable codes, gates and messages.", "Reason codes include source-missing, mixed-release, lost-writes, body-mismatch, latency-p99, observer-failed, stale-evidence, truncated, delivery-incomplete, recovery-unverified and window-open."],
  access: "read", targets: ["orange", "node"],
  options: { evidence: { type: "string", placeholder: "DIR", description: "saved evidence bundle directory", required: true }, now: { type: "string", placeholder: "MS", description: "evaluation time in Unix milliseconds (default: current time)" }, replay: { type: "boolean", description: "replay decision.json at its recorded time" }, "receipt-out": { type: "string", placeholder: "PATH", description: "create an immutable qualification receipt outside the evidence directory" } },
  exclusive: [["now", "replay"]],
  examples: ["statsctl verify release --evidence .work/release --json", "statsctl verify release --evidence .work/release --replay --json", "node dist/statsctl.mjs verify release --evidence .work/release --receipt-out receipt.json --json"],
  limitations: ["Evidence is supplied by the external rollout controller; this command does not collect or authenticate it."],
  async run(context) {
    const evidence = readReleaseEvidence(context.option("evidence")!, context.flag("replay"));
    const arg = context.option("now");
    if (arg !== undefined && (!/^(0|[1-9][0-9]*)$/u.test(arg) || !Number.isSafeInteger(Number(arg)))) throw usageError("--now must be a nonnegative integer Unix time in milliseconds");
    const payload = decideRelease(evidence, context.flag("replay") ? evidence.decision!.evaluatedAtMs : arg === undefined ? context.now() : Number(arg));
    if (context.flag("replay") && (evidence.decision!.verdict !== payload.verdict || JSON.stringify([...evidence.decision!.reasonCodes].sort()) !== JSON.stringify(payload.reasons.map(reason => reason.code).sort()))) throw transportError("contract", "release decision replay does not match recorded verdict and reason codes");
    const receipt = context.option("receipt-out");
    if (receipt !== undefined) {
      if (evidence.decision === null) throw usageError("--receipt-out requires decision.json");
      const recorded = decideRelease(evidence, evidence.decision.evaluatedAtMs);
      const codes = (result: typeof recorded) => JSON.stringify(result.reasons.map(reason => reason.code).sort());
      if (evidence.decision.verdict !== payload.verdict || evidence.decision.verdict !== recorded.verdict || JSON.stringify([...evidence.decision.reasonCodes].sort()) !== codes(payload) || codes(recorded) !== codes(payload)) throw usageError("--receipt-out requires a replayable decision.json matching the current verdict");
      writeReceipt(context.option("evidence")!, receipt, evidence, recorded, context.now());
    }
    return { payload, exit: { pass: EXIT.ok, reject: EXIT.regressed, inconclusive: EXIT.unchanged, pending: EXIT.pending }[payload.verdict] };
  },
  render(payload) { return [`release verdict ${payload.verdict} for policy ${payload.policy}`, ...payload.reasons.map(reason => `${reason.code}: ${reason.message}`)]; }
});
