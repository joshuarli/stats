# Stats performance resumption

The owner requested STA-128 and STUF-87, followed by continued performance
campaign work from `HANDOFF-STATS-PERFORMANCE.md`, on November 16, 2026.
The original acceptance thresholds and isolated workload boundary still apply.
Production and the shared Engine remain unchanged during private qualification.

## Runtime prerequisite

Stuff PR39 merged as `511cf183423ba47b010f1947e1810161a70869a0`.
All ten checks passed on head `9510e79058a4b0269402d73775c816771c83afad`.
Its four SQLite patches repair staged refusals, stale heads, unnecessary empty
aborts and committed-page read refusals. The source and private correctness
evidence are in Stuff's `docs/openorange-sqlite-page-read.md` and accompanying
proof. STUF-87 is resolved there. This does not establish Stats P6 or P9.

The repaired release binary SHA-256 is
`611b08f609d625ad5379c3b0801f23fc76ab4e17cc3ee0210ba608bf53ae1b01`.
The stopped private fixture contains 203,950 verified rows and three accepted
Engine-only recovery cycles. The campaign still requires its original ten
cycles and the other recovery conditions.

## STA-128 attempt boundary

Use one copy of the stopped repaired fixture for functional setup checks.
Its old event timestamps cannot establish the complete seven-day workload.
Preserve the original fixture and every failed receipt.

Prepare one fresh timestamped fixture, with a 1,800-second deadline, using the
same frozen corpus and repaired release binary. Keep the existing two-CPU,
3-GiB limits, 500-row import pages and 250-ms pacing. A failed import exhausts
this ticket's fresh preparation allowance. Diagnose it without another import.

After functional verification, run one five-pair study with ten real browser
clients and representative ingestion. Each client performs 20 uncached and
20 cached selections per range per round. Measure process CPU for Stats and
Engine separately. The collector shares the driver process and has a separate
CPU accounting field. Keep exact summaries, canonical ingested events,
duplicate acknowledgments, conflict responses and malformed-input failures.
Inject collector HTTP 503 responses and require unchanged application outcomes.

Both hosts must pass `perf-gate-ready` before and immediately after timing.
Report inconclusive when same-variant CPU spread exceeds 3% or latency spread
exceeds 5%. A diagnostic rehearsal never counts as the accepted study.
No full campaign workload allowance is consumed by a functional rehearsal.

## Campaign continuation

After STA-128, pursue the unused three-run P6 allowance on the complete fixture.
Use the ordinary tailnet ingress for campaign browser acceptance. An SSH tunnel
is a functional setup route and must stay explicit in any study receipt.
STUF-86's merged lifecycle API repair supplies a possible natural sleep signal.
Verify the actual signal before collecting sleep latency. Do not replace sleep
with restart or elapsed idle time.

P8 still requires a complete valid 24-hour series and the stated coverage.
STUF-88's partial inventory retry repair does not establish availability.
Do not restart a known-invalid sampler or change its acceptance rules.
Use the original handoff for the remaining recovery and closeout conditions.

## Current verification

The [functional rehearsal](../bench/results/2026-11-17-observation-overhead/README.md)
passes all three conditions on ten browsers. Collector HTTP 503 leaves browser
results and exact ingestion unchanged. Lisa gates are busy. No overhead bound
or campaign timing acceptance follows.

Seven Linux container regressions pass without skips. The analysis cases cover
precision limits, incomplete rounds, per-range regressions, failed gates,
missing delivery, missing ingestion, wrong responses, browser failures and
collector failure. CPU parsing handles process names with spaces and
parentheses. Cancellation during startup removes both owned processes.
Its hand fault is caught. Pinned-Node syntax checks and lint pass.

The single fresh preparation completed successfully at 2026-11-17 06:12:05 UTC
in container `stats-sta128-fresh-20261117`, which is stopped. It acknowledged
all 203,950 events and verified four complete reference responses, 64 duplicate
events, changed-duplicate HTTP 409 and an equal summary after application reopen.
[The receipt](../bench/results/2026-11-17-observation-overhead/fresh-preparation.json)
and [fixture proof](../bench/results/2026-11-17-observation-overhead/fresh-fixture.json)
retain the identities and checks. This is correctness evidence, not an import
speed or recovery-latency result.

Its namespace is `stats-scale-sta128-fresh-20261117`. Protected state,
credentials and logs are under
`/home/josh/.work/stats-perf-campaign/sta128-20261117/fresh/` on Lisa.
The single preparation allowance is consumed. Do not start a second import.
The seven-day request remains retention-clamped against the import's fixed
historical endpoint. Do not call it complete seven-day browser acceptance.

The earlier copied rehearsal is stopped in container `stats-sta128-20261117`.
Its state remains at the parent protected directory. Source copies live under
that directory's `source/`. The session-owned Mac SSH forwarding process is
now stopped. Nothing in these scratch paths substitutes for the committed
reproduction instructions.

The [fresh rehearsal](../bench/results/2026-11-17-observation-overhead/fresh-rehearsal.json)
passes all three conditions, all twelve host gates and exact output checks.
The seven failed collector exports leave application outcomes unchanged.
Application delivery failures are zero in both measured variants.

The first full study stops during its initial disabled round. Two of ten
browsers report incomplete journeys. The other eight finish their 20 cycles.
All four host gates pass and all completed response digests remain correct.
[The failed receipt](../bench/results/2026-11-17-observation-overhead/failed-study.json)
retains the entire cohort. No enabled round or overhead comparison is accepted.
The original failure details did not distinguish response failure, cancellation
and missing rendered data. Do not infer the cause from that generic error.

The bounded [full-length diagnostic](../bench/results/2026-11-17-observation-overhead/full-diagnostic.json)
completed all 800 uncached and 800 cached selections in each variant. It did
not reproduce the two incomplete journeys. Enabled delivery reported 674
application failures and contaminated browser drop counters. Hash-only
navigation retained the previous document and its delivery state. A real-browser
regression proves that mechanism; distinct variant/round query strings now
force a new document. This does not establish the cause of the original
incomplete journeys, or account for every delivery failure in that diagnostic.

A subsequent [profiled diagnostic](../bench/results/2026-11-17-observation-overhead/cpu-profile-workload.json)
uses fresh documents and five cycles per browser. Both variants complete 200
uncached and 200 cached selections with exact responses and 1,024 canonical
stored events. The enabled variant delivers 400 browser observation posts,
with zero failed, pending or dropped posts and zero application delivery
failures. Collector HTTP 503 again leaves application outcomes unchanged.
Profiling is explicitly excluded from timing acceptance. Neither diagnostic
replaces the failed accepted-study attempt or resets its allowance.

## Accepted ingestion optimization

Native profiling identifies synchronous SQLite transaction boundaries on the
ingestion path. These stacks can include native waits; they do not isolate
SQLite CPU. Canonical insertion now batches up to 16 events per statement
inside the existing transaction. The 64-event regression reduces SQL calls
from 68 to at most ten, retaining canonical identity, duplicate/conflict
behavior, occurrence grouping and rollback. No API, schema, permission or
transaction boundary changes.

[Five native component pairs](../bench/results/2026-11-17-native-ingest-batching/README.md)
verify every canonical event, summaries and failure outcomes. Median CPU falls
38.8% and HTTP ingestion elapsed time falls 45.8%, with unchanged database growth,
no memory-limit events and a 343-byte bundle increase. Gates pass around the
whole comparison. This is a component result, not full P6 or P7 acceptance.
Thirty-five focused store, rollup, snapshot, workerd and Node HTTP tests pass;
observation typecheck and lint pass. No production deployment occurred.

## Recovery continuation and blocker

The [Engine-only cohort](../bench/results/2026-11-17-observation-overhead/engine-recovery.json)
passes nine cycles with all pre/post host gates, unchanged application process
identities, exact fixed-window summaries, all 219,939 canonical event rows and
full Installation state. Shutdown-to-verified-data latency ranges from 3.98 to
7.53 seconds, below the 15-second limit. This covers Installation and
`observe:stats`; it does not establish recovery for every platform sink.

The tenth TERM exits with code 1 before restart. Engine logs report
`dependent_failed` and a singleton worker lease fence. The earliest trigger
is unproven. The worker's deliberate hard exit protects heartbeat lifetime;
do not remove that safeguard to make the cohort pass. Ten-cycle acceptance
fails. No tenth reopen or retry was attempted, and no post-failure data-loss
claim is supported.

[STUF-90](https://github.com/laputa-systems/stuff/blob/main/docs/openorange-engine-term-fence.md)
retains the source investigation and exact log hashes in Stuff main commit
`90c9511`. The stopped failed depot remains on Lisa under
`/home/josh/.work/stats-perf-campaign/sta128-20261117/fresh/`.
Preserve it before reopening: copy the whole stopped root and rewrite both
Engine storage paths into the copy. The server now rejects storage paths
outside its selected root. The unrelated component-comparison depot is under
`insert-comparison/` and must not substitute for the tenfold fixture.
All containers created for this resumption are stopped. The historical
`stats-perf-scale-server` and shared production services remain untouched.

## Next acceptance conditions

STA-128 remains open. Classify the original browser failure and retain the
attempt ledger before another accepted overhead comparison; no new attempt
allowance is implied by these diagnostics. A valid result still requires five
complete pairs and the original precision, delivery and exact-output checks.
P6 still needs complete windows through ordinary tailnet ingress. The fixed
historical endpoint remains retention-clamped. No additional tenfold import
is authorized by this record.

Resolve STUF-90's shutdown trigger before another ten-cycle acceptance cohort.
P2 still needs positive natural-sleep evidence and its original sample count;
STUF-86 provides the API capability, not Stats acceptance. P8 remains blocked
on STUF-88 availability and complete queue coverage. No replacement soak ran.
Full repository tests and the release gate remain unrun. Production is unchanged.

## November 17 follow-up

The [attempt ledger and private fence diagnosis](../bench/results/2026-11-17-term-fence-diagnosis/README.md)
preserve the consumed allowances and the original browser evidence gap.
The original failed depot stays stopped and unchanged. Diagnostic logging
retains every dependent-fence call site without removing the heartbeat guard.
The dev setup times out while exporting its initial exact snapshot, before
any planned diagnostic shutdown. Its cleanup exits normally. This neither
reproduces nor resolves STUF-90.

The release setup identifies an observation fence left by that timed-out
request. The benchmark server now owns restoration before requesting a fence
and retains both snapshot and cleanup failures. Two controlled regressions
fail before this repair and pass after it. All eleven focused Linux tests
pass without skips. The investigation explicitly restores its fence on the
copy, then completes three diagnostic TERM stops with exit zero. Both
intervening reopens preserve full observation and Installation snapshots.
There is no post-third-stop snapshot. STUF-90 remains unreproduced and open.
The diagnostic container is stopped. No import or acceptance allowance resets.

The owner separately runs and cancels `make deploy`. The
[deployment investigation](DEPLOYMENT-STALL-INVESTIGATION.md), STA-129,
records successful image creation and restart followed by interrupted
rollback. Read-only inspection finds `stats:6cc06db247a3` selected at version
26 while the running container uses `stats:c9a71b2ba127`, node version 25.
Public health and the probed data routes answer HTTP 200. OpenRC reports
`starting`. This owner-triggered deployment supersedes the earlier unchanged
production status. The agent has not changed production selection or services.
The owner clarifies that the requested follow-up improves the deployment
command's progress, timeouts, and rollback. It does not upgrade the shared
Engine or authorize a production reconciliation.
