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

Five Linux container regressions pass without skips. The analysis cases cover
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
that directory's `source/`. The active Mac SSH forwarding process is owned by
this session; inspect its command before any later cleanup. Nothing in these
scratch paths substitutes for the committed reproduction instructions.

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

One diagnostic reproduction with 20 cycles per browser is active in
`stats-sta128-study-20261117`. Its driver adds failing-journey context without
changing the success checks. This is diagnosis, not a replacement accepted
study or another import. After this reproduction, classify the failure before
any new timing comparison. Do not silently reset the one-study allowance.

The container's internal address is `172.31.90.3`. The Mac tunnel forwards
container ports 8787 and 8790 to loopback ports 18787 and 18790. The driver
owns loopback proxy port 18887. The final source includes per-round host gates,
per-range p95 analysis, cached-output checks, a six-second export drain, source
digests and browser delivery counters. Its five Linux regressions pass.
Accepted overhead timing remains pending.
