# Stats performance campaign

## Status

Active. Goal: immediate, explainable Stats interactions on Lisa at ten times
the frozen production corpus. Last deployed revision: `6cc06db247a3`.
Production application: `stats:6cc06db247a3`, Orange node version 24.
The compatible rollback image is `stats:03d3d4f1fcb8`, node version 23.
Exact second/minute rollups are live; deployment smoke and marker delivery pass.
P1's prior 200-cached-selections-per-range run passes with p95 below 35 ms and no
summary fetches; the frontend implementation is unchanged. P2's awake,
empty-client-cache portion passes again on node version 22: 200 uncached
selections per range yield click-to-complete p95 of 118 ms (1h), 215 ms (6h),
321 ms (24h) and 317 ms (7d). All counts, windows and charts match their real
responses; no requests fail, cancel or remain unsettled. All four Mac/Lisa timing
gates pass. Positive actor-sleep acceptance remains open.

P3 passes on the current corpus: 200 genuine new documents reach useful health
and complete charts at p95 374 ms. Every navigation uses the default 1h range,
an awake actor and the normal HTTP asset cache. All documents have distinct
navigation origins, real uncached summaries and matching visible data; all four
timing gates pass. This is not tenfold or cold-asset percentile acceptance.

P4 has complete paired timing evidence for all 17 delivered journeys over one
second in the captured release cohort. Stored browser and HTTP trace/span IDs
match, and shared server timing fields agree exactly. This is observed cohort
coverage, not a lossless-delivery or population guarantee. P5's five incident
fixtures, plus missing and historical data, pass on desktop and mobile. The
overview guidance is live.

P7 freshness passes for 200 paced observations: p95 below 1.45 seconds and no
drops or errors. A separate burst accounts for 908 stored journeys and 97
reported browser transport drops, with zero producer drops. Instrumentation CPU
and latency overhead remain open. P8's browser check retains 0.50 MiB after 200
navigation cycles with delivery enabled; DOM nodes and listeners remain flat.
A read-only production soak started at 2026-11-15 16:41:10 UTC on node version 24.
It samples application RSS, actor states, retention backlog and the private bridge
queue once per minute. It requires a full day and analysis; runtime inbox depth
and undelivered application-producer queues remain explicit coverage gaps.
Null Engine lifecycle timestamps remain unknown states, rather than evidence
of pending allocation or sleep. The earlier sampler trial is excluded.

The native tenfold fixture contains 203,950 independent event identities. All
complete summaries match an independent reference; duplicate acknowledgment,
conflict rejection and restart equality pass. Bulk loading encounters native
write backpressure and is resumed from integrity-checked progress. Recovery
retains all 189,000 previously acknowledged rows. This is fixture preparation,
not sustained-ingest acceptance. With the loader removed, repeated 24h reads
take 918–975 ms across five samples, mostly in SQL; the first takes 12.1 seconds.
Both Lisa timing gates pass. P6 remains open.

The compact, exact derived table improves warmed 24h reads from a median
1,043 ms to 640 ms across five alternating rounds. All 48 complete comparison
responses match baseline digests and actual query-source markers. Both Lisa
timing gates pass. This is component evidence, not concurrency acceptance.
Canonical events and summary APIs stay intact. The implemented projection passes
213 observation tests, backfill and mutation regressions, type checks and lint.
Native backup restores exact application summaries through canonical tables and
rebuilds the projection. The compatible snapshot reader is live before rollout.
Five alternating native write rounds per version preserve all acknowledgments,
duplicates and conflicts; both timing gates pass. A 512-event actor uses 45,056
additional SQLite bytes. Median acknowledgment and CPU differences are smaller
than the observed candidate spreads. The protected pre-projection backup holds
16 tables and 228,029 rows, including 52,393 canonical events. Its 59-second
observation-only fence is reopened and verified. Ten-client acceptance remains
open.

Maintained second/minute rollups now reduce ten-client 24h HTTP p95 from
5,513 ms to 398 ms in five alternating native rounds, with 50 warm responses
per range and variant. All 480 complete response hashes match, both Lisa timing
gates pass, and native writes preserve acknowledgments, duplicate detection and
the exact canonical snapshot. The [rollup evidence](../bench/results/2026-11-15-maintained-rollups/README.md)
separates this component result from full P6 browser and ingest acceptance.

Reopening the disposable read fixture later encounters a native command-volume
quorum failure before candidate code runs. The failed state and Engine logs are
preserved. This is an unresolved recovery gap; production remains healthy.
The isolated lifecycle fixture verifies idle constructor replacement, overdue
alarms and interrupted replay; broader P9 recovery remains open. S3 stays
deferred. Integration: `.work/wt/runtime-hardening`, `feat/runtime-hardening`.

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
- [Live awake uncached range acceptance](../bench/results/2026-11-15-live-reads/README.md)
- [Live initial-document navigation](../bench/results/2026-11-15-live-navigation/README.md)
- [Slow journey attribution coverage](../bench/results/2026-11-15-journey-coverage/README.md)
- [Tenfold native baseline](../bench/results/2026-11-15-tenfold-baseline/README.md)
- [Compact projection comparison](../bench/results/2026-11-15-compact-projection/README.md)
- [Producer delivery and freshness](../bench/results/2026-11-15-producer-boundaries/README.md)
- [Covering-index evidence and costs](../bench/results/2026-11-15-covering-index/README.md)
- [Retained browser heap](../bench/results/2026-11-15-browser-retention/README.md)
- [Runtime capabilities and remaining gaps](runtime-hardening.md)
- [Production validation and rollback](runtime-hardening-handoff.md)
- [Frontend measurement history](frontend-efficiency.md)
- [Current native observability contract](platform-observability.md)
