# Stats performance campaign

## Status

Active. Goal: immediate, explainable Stats interactions on Lisa at ten times
the frozen production corpus. Last deployed revision: `506b622debb4`.
Production application: `stats:506b622debb4`, Orange node version 19.
Earlier cancellation, cache and batching fixes are prerequisites, not proof
that this campaign's latency goals pass. P1 passes on the current live corpus.
P5 incident fixtures pass. Tenfold scale and the other full acceptance goals
remain open.

P4 measurement boundaries now have browser and native regressions. A frozen
20,395-event corpus and 1,000 cached interactions per variant establish no
measurable timing overhead. Bounded browser delivery and trace correlation are
live, with native persistence coverage and 117 passing production health checks.
Live P1 repeats retain 200 samples per range, p95 below 35 ms and no measured
summary fetches. Producer drains now stop at an accepted boundary. The burst
accounts for all 1,005 observations: 908 stored and 97 reported browser drops.
Two hundred paced observations become queryable at p95 below 1.45 seconds,
with no drops or errors. Instrumentation CPU and latency overhead remain open.

Native profiling identifies canonical-table lookups hidden behind the compact
expression index. A genuinely covering index removes them. Five interleaved Lisa
rounds reduce first-1h aggregate SQL from median 2,465 ms to 123 ms. Complete
response equality, old-data backfill, export compatibility, duplicate identity,
native restart and write-cost checks pass. The following 24h read is slower
after the variants warm different pages. Production navigation and percentile
acceptance remain open. Next: deploy the derived index and measure browser
journeys, then address the remaining bottleneck.
Integration checkout: `.work/wt/runtime-hardening`, branch `feat/runtime-hardening`.
The isolated lifecycle fixture proves constructor replacement after idle,
autonomous overdue alarms after runtime restart, and idempotent interrupted
request replay. Local readiness stayed below 15 seconds in three starts. This
is platform-fixture proof; production recovery acceptance remains open.
The overview guidance is live. Five incident fixtures, plus missing and historical
data, pass working-destination tests on desktop and mobile. No active child
writers. The parent owns index rollout and browser acceptance. S3 work remains
deferred.

## Charter

Continue without requesting approval for authorized repository and production
application changes. Commit and push verified slices. Keep the campaign active
until every acceptance goal has evidence. Report blockers without relabeling
unmeasured or deferred checks as passing.

Preserve canonical data, exact ingest acknowledgments, authentication, bounded
queues and missing-data semantics. Compare exact outputs before accepting a
speedup. Change one attributable mechanism at a time. Keep or reject each
candidate before starting another optimization of the same path.

One implementation writer is the default. Independent review and disjoint
test work may use the Pi bridge in separately owned worktrees. Retire completed
children after integration and proof. Keep benchmark artifacts outside scratch
once they support an accepted claim. Raw production data and credentials remain
in protected local storage.

## Acceptance goals

| ID | Outcome | Passing evidence |
| --- | --- | --- |
| P1 | Instant cached ranges | Selection to complete charts p95 <50 ms and p99 <100 ms. Zero summary fetches within the valid generation |
| P2 | Fast uncached ranges | Awake actor, empty client range cache: 1h, 6h and 24h p95 <750 ms. After actor sleep: p95 <1,500 ms. Seven-day views p95 <2,000 ms |
| P3 | Fast navigation | Initial project navigation to useful health p95 <1,000 ms and complete overview charts p95 <2,000 ms |
| P4 | Explain slow journeys | Browser input, fetch, server, actor, SQL, decode and render phases correlate. At least 99% of delivered journeys over one second identify the dominant phase. Missing phases stay explicit and do not count as successful attribution |
| P5 | Actionable overview | Scripted healthy, failing, slow, stale and post-deployment incidents expose state, onset and a useful investigation target within ten seconds |
| P6 | Maintain performance at scale | P1–P3 pass against ten times the frozen production corpus, with representative ingestion and ten concurrent dashboard clients. Acknowledged samples remain exact and duplicate handling remains correct |
| P7 | Cheap self-observation | Events queryable p95 <5,000 ms. Enabled instrumentation adds <3% CPU and <5% request latency against disabled instrumentation. Collector failure does not change application outcomes |
| P8 | Stable resource use | Retained browser heap grows <5 MiB after 200 warmed navigation and range cycles. During a 24-hour representative soak, memory, actor counts and queue depths plateau |
| P9 | Proven native recovery | Repeated ordinary restart, idle eviction, overdue alarms and interrupted requests preserve acknowledged state. Ordinary restart readiness <15 seconds |

No goal is satisfied by a cache hit substituted for a cold read, an empty
response, a missing event, a relaxed durability boundary or a rejected request.
The seven-day target uses the actual retention window. Thirty-day selection
does not imply thirty days of retained application events.

## Measurement contract

Freeze and checksum a bounded read-only capture of the current retained Stats
application corpus before establishing campaign baselines. Record capture
bounds, row counts, completeness and source release. Keep the raw capture private.
The tenfold fixture preserves size, operation mix, outcomes and time distribution
while assigning independent event identities.

Measure complete browser journeys on the Mac over the normal tailnet route to
Lisa, with fixed viewport, browser build and device settings. Record request,
asset and response bytes. Navigation ends when useful health and all expected
charts have committed visible data. Existing charts must not count as a new
window's completion. Errors and cancellations remain in the result set.

Cached, awake uncached, actor-sleep and process-start states are separate.
Actor sleep needs positive runtime evidence. Reboot and disk-cache coldness
are separate conditions. Never flush Lisa's caches to simulate a benchmark.
Resource and workload measurements distinguish Stats from the shared Engine.

Run at least five interleaved baseline and candidate rounds. Collect at least
200 successful journeys per latency condition for percentile acceptance, while
also recording every failure. Keep per-range distributions separate. Report
sample counts, spread, p50, p95 and p99. Timing gates must pass before and after
accepted measurements. Busy-host runs remain diagnostics. Memory and size
checks always run. Profiling runs stay outside timing comparisons.

For P8, discard the warmup portion and record the complete time series. The
final 12 hours must have no sustained upward trend in queues or actor counts,
and median Stats RSS must stay within 5% of the preceding six-hour median.
Record traffic and retained-data growth alongside resource changes.

## Sequence

1. P4: add bounded browser journey measurements and correlation, with privacy,
   auth, abort, cache and chart-completion regressions. Own client measurement
   code, the narrow ingestion adapter and associated tests.
2. P1–P3: establish the frozen browser baseline and optimize its largest phase.
   Own only the demonstrated frontend, query or runtime bottleneck per slice.
3. P5: exercise incident fixtures and implement missing overview decisions.
4. P6–P7: run the enlarged native workload, contention and enabled/disabled
   instrumentation comparisons. Keep shared infrastructure changes in Stuff.
5. P9: extend isolated native lifecycle and failure rehearsals.
6. P8: start the 24-hour soak after correctness and latency checks pass.
   Other disjoint verification may run while it completes.

Each slice names its executable proof before implementation. Existing entry
points are `make orange-test`, `pnpm --dir cloudflare test:observe`, targeted
Playwright cases and the checked-in native benchmark harness. New proof
commands belong with their implementation. A command name without successful
output does not satisfy a goal.

## Execution boundary

Production application deployment and validation are authorized. Preserve the
existing conditional deployment and rollback path. No Engine upgrade, credential
rotation or durable-data migration is implied by this campaign document.
S3 backups remain deferred as STUF-75 P1. No new database, orchestrator or
general-purpose trace backend is part of this campaign.

Candidate API, schema, permission and transaction changes must be explained
before implementation and verified with affected callers. Use isolated copies
for failure, enlarged-data and recovery tests. Do not stress other applications
or restart the shared Engine for performance experiments.

## Evidence and environment

Lisa SSH, private HTTPS and an owned browser session are available. No owner
action is currently required. The full-day soak requires elapsed time and a
stable candidate. It is required evidence, not a waived gate.

- [Prior range and batching measurements](../bench/results/2026-11-14-range-refresh/README.md)
- [Browser journey measurements](../bench/results/2026-11-14-project-journey/README.md)
- [Live cached range acceptance](../bench/results/2026-11-15-live-cached-ranges/README.md)
- [Producer delivery and freshness](../bench/results/2026-11-15-producer-boundaries/README.md)
- [Covering-index evidence and costs](../bench/results/2026-11-15-covering-index/README.md)
- [Runtime capabilities and remaining gaps](runtime-hardening.md)
- [Production validation and rollback](runtime-hardening-handoff.md)
- [Frontend measurement history](frontend-efficiency.md)
- [Current native observability contract](platform-observability.md)
