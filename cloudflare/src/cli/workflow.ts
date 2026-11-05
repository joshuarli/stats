export const WORKFLOW = `statsctl workflow: recipes

Every recipe is copy-pastable from the repository root. Add --json to get one statsctl/1
document on stdout (payload or error); the JSON verdict and the exit code always agree.
All times are UTC. A window is half-open: [fromMs, toMs).

1. Discover projects
   pnpm --dir cloudflare -s statsctl projects
   pnpm --dir cloudflare -s statsctl health --project stats --json
   health judges collector freshness, deployment sync, and observe health separately.
   Fix anything unhealthy or unavailable before trusting a cost or verdict.

2. Find a bottleneck and drill into it
   pnpm --dir cloudflare -s statsctl cost --project stats --window 1h --json
   pnpm --dir cloudflare -s statsctl cost --project stats --window 24h --series --json
   pnpm --dir cloudflare -s statsctl observe routes --project stats --window 1h --json
   pnpm --dir cloudflare -s statsctl observe traces --project stats --window 1h --failed --json
   Read the biggest priced line in cost, then the routes that spend CPU. Totals name their
   priced meters, excluded meters, and residuals; uncollected means no data, never zero.

3. Save a snapshot and replay it offline
   pnpm --dir cloudflare -s statsctl snapshot --project stats --window 24h --out .work/statsctl/snapshots/stats-24h.json
   pnpm --dir cloudflare -s statsctl cost --input .work/statsctl/snapshots/stats-24h.json --json
   A snapshot holds raw frames, decoded deployment and observe data, windows, revisions, and
   SHA-256 hashes. --input refuses a mismatched schema, pricing revision, or hash with exit 4.

4. Compare an exact deployment
   pnpm --dir cloudflare -s statsctl deployments --project stats --json
   pnpm --dir cloudflare -s statsctl compare --project stats --deployment DEPLOYMENT_ID --window 1h --json
   Use the immutable deployment id from the list, never a log line. The comparison excludes
   the deployment bucket and one warm-up bucket; read its reasons before its metrics.

5. Write a policy
   Commit the hypothesis and policy before deploying the candidate.
   cat > bench/policies/EXPERIMENT.json <<'JSON'
   {"id":"EXPERIMENT","project":"stats","operation":"host.ingest","metric":"rowsWrittenPerPersistedSample","minOperations":100,"materialChangePercent":10}
   JSON
   pnpm --dir cloudflare -s statsctl verify --project stats --deployment DEPLOYMENT_ID --window 1h --policy bench/policies/EXPERIMENT.json --readiness --json
   --readiness lists each signal the policy needs as available or unavailable:<code>. A
   signal the policy does not use never blocks it.

6. Wait for settlement
   pnpm --dir cloudflare -s statsctl verify --project stats --deployment DEPLOYMENT_ID --window 1h --policy bench/policies/EXPERIMENT.json --wait --timeout 2h --json
   --wait sleeps until the after window is ready, then polls at most every 15 minutes with
   If-None-Match. On timeout it exits 5 with pending and prints the command to resume.

7. Interpret the verdict (exit codes: 0 improved, 5 pending or insufficient-data,
   6 unchanged or confounded, 7 regressed)
   insufficient-data  a side has too few operations or the signal is missing. Not a pass.
                      Wait for more traffic or widen the window; never lower the minimum.
   confounded         another deployment overlapped a window, the workload mix moved, or
                      coverage is not reconciled. The result says nothing about the change.
                      Retry in a clean window; it may be retried twice per candidate.
   inconclusive       the effect is below the policy's material change or metric floor.
                      Treat it as no evidence either way, not as a small win.
   regressed          any guardrail failed. It outranks every other verdict.

8. Resume after an interruption
   pnpm --dir cloudflare -s statsctl verify --project stats --deployment DEPLOYMENT_ID --window 1h --policy bench/policies/EXPERIMENT.json --wait --timeout 2h --json
   State lives in .work/statsctl/verify/DEPLOYMENT_ID.json; repeating the same command
   continues from it and counts requests across runs.

9. Check ingest end to end (mutation)
   pnpm --dir cloudflare -s statsctl check ingest --credential-file .work/credentials/synthetic-check.json --json
   Writes one real, flagged sample. Run it only with the synthetic-check credential and
   only inside the excluded deployment and warm-up interval.

Why a lower monthly estimate is not necessarily a win
   cost projects a month from one window, so it moves with traffic, time of day, and which
   meters were collected. A candidate can look cheaper because load fell, because a meter
   went uncollected, or because work moved to a line that is not priced. Only verify
   compares the same operation per unit of the same work across matched windows, with
   guardrails for failures, lost data, and coverage. Trust its verdict, not the estimate.

Authentication
   statsctl runs \`cf access token <origin>\` with no stdin and a 20 s limit and sends the
   output in the cf-access-token header. Override with STATSCTL_AUTH_COMMAND (run with
   sh -c) and STATSCTL_AUTH_HEADER. It never starts a login; if it fails, run
   cf access login <origin>. The credential is sent only to the configured origin.`;
