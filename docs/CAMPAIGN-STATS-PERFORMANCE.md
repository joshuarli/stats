# Stats performance campaign

## Status

Active, re-scoped on 2026-11-15. The goal is immediate, explainable Stats
interactions on Lisa at ten times the frozen production corpus.

W2 preparation branch review is integrated as `b15839f2a32`; both Linux
container regressions and pinned-Node lint pass. Preserved imports failed
before the full corpus was ready; their cause is not yet classified.
No full W2 run was started and its budget remains three runs. See the
[review and failure evidence](../bench/results/2026-11-15-scale-prep-review/README.md).
The single W2 rebuild failed in protected Lisa state
`campaign-rebuild-20261115/`, namespace `stats-scale-rebuild-20261115`.
Its driver is `rebuild-scale-once.mjs` and output is
`campaign-rebuild-20261115.log`; it exited 1 after 70,500 acknowledged rows.
The private Engine fenced its volume again. W2 is blocked on fixture durability
(Stuff STUF-87); no full timing run was possible. Do not start another rebuild.
W3's two observability checks found no positive
sleep signal; the sleep condition is blocked as unobservable, tracked in
Stuff STUF-86. W4 is blocked on the unavailable complete W2 workload; Stats
STA-128 retains the overhead and collector-failure acceptance study. W5's
single investigation localized the failure to Engine volume fencing, but did
not establish whether configuration/resource limits or an Engine defect is
the underlying cause; repeated native recovery is blocked on STUF-87.
W6 still awaits the soak deadline. Read-only inspection found actor-list HTTP
503 samples and an application-health timeout in the live series (Stuff
STUF-88); it cannot
pass the no-unavailable-groups requirement. Preserve the running sampler until
completion, then apply the one allowed invalidation restart. The analyzer and
its regression tests are ready; see the
[progress record](../bench/results/2026-11-15-soak-progress/README.md).
The campaign is not closed.

The previous execution ran too long because it had no stopping rules. Several
goals depend on elapsed time or on Engine behavior outside this repository.
This revision keeps every acceptance threshold. It bounds each remaining
attempt and defines when to report a result as blocked.

Production runs `stats:6cc06db247a3` on Orange node version 24, built from code
revision `af4890a3bb5`. The rollback image is `stats:03d3d4f1fcb8` on node
version 23. Earlier images are unsuitable rollback targets after rollup creation;
see [the handoff](runtime-hardening-handoff.md). Master contains the deployed
code. Every later commit changes only bench, docs, CI or tests, so production
does not need a redeploy to be current.

| ID | State | Remaining work |
| --- | --- | --- |
| P1 | **Pass** on the current corpus | Repeat at tenfold within P6 |
| P2 | Awake 1h/6h/24h and 7d **pass**. After actor sleep: **blocked (unobservable)** | Stuff STUF-86; [evidence](../bench/results/2026-11-15-scale-prep-review/README.md#w3-sleep-observability) |
| P3 | **Pass** on the current corpus, with a warm asset cache | Repeat at tenfold within P6 |
| P4 | **Pass** for the observed cohort: 17 of 17 journeys over 1 s | None. Population coverage is not claimed |
| P5 | **Pass** on desktop and mobile; guidance is live | None |
| P6 | **Blocked (fixture import volume fencing)**; component evidence only | Stuff STUF-87; [rebuild evidence](../bench/results/2026-11-15-scale-prep-review/README.md#single-rebuild-result) |
| P7 | Freshness **passes**; overhead **blocked (complete W2 workload unavailable)** | STA-128; W4 has no study or precision claim |
| P8 | Browser heap **passes**; the 24h soak is **running** | W6 |
| P9 | **Blocked (native volume fencing; underlying cause unresolved)**; partial lifecycle evidence retained | W5 investigation exhausted; Stuff STUF-87 |

## Hard constraints right now

- **Deploy freeze until the soak ends.** The P8 sampler started at
  2026-11-15 16:41:10 UTC. It runs as PID 3384 on Lisa and has 1,441 samples
  planned. A production deployment stops collection and invalidates the run.
  Do not deploy production before 2026-11-16 16:41 UTC. Do not stop, duplicate
  or clean up the sampler. Its procedure is documented in the
  [rollup record](../bench/results/2026-11-15-maintained-rollups/README.md#read-only-production-soak).
- All work before the soak ends uses the isolated tenfold fixture at
  `stats-next.17166969.xyz` or local suites. Do not stress production or other
  applications, and do not restart the shared Engine.

## Work queue

Execute in order. W2–W5 may interleave while the soak runs. Each item has an
attempt budget. When an item exhausts it, record the evidence as **blocked**
with its cause, then move on. Budgets are fixed; do not extend them.

### W1. Repository reconciliation (done 2026-11-15)

`feat/runtime-hardening` is merged into master, and master passes `make lint`.
All campaign worktrees are retired. Their uncommitted drafts were not on master,
so they were pushed unreviewed to `origin` instead of being deleted:

- `wip/native-scale-prep`: private-Engine preparation for the tenfold fixture
  (`bench/native-scale-engine.mjs` and changes to `bench/native-scale-fixture.mjs`).
  Its tests run only inside the Linux fixture container. Start W2 by reviewing
  and verifying it there, then merge it or drop it.
- `park/perf-overview`, `park/perf-native-recovery`, `park/perf-live-reads`,
  `park/preview-production`, `park/perf-producer-drain` and
  `park/native-dashboard-bench`: earlier drafts of work that has since landed.
  Use them only if a W item needs something missing from master. Delete them at
  campaign close.

Create new worktrees under `.work/wt/` from master, and retire each after it is
integrated. The `btree`, `ci-pnpm`, `upgrade-*` and `s10-schema2` worktrees are
unrelated to this campaign. Leave them alone.

### W2. P6 tenfold acceptance on `stats-next` (budget: 3 full runs)

Run one combined workload against the 203,950-event fixture:

- Ten concurrent real browsers performing the P1, P2 and P3 journeys.
- Representative ingestion following the frozen corpus's operation mix.
- At least 200 successful journeys per range and condition.
- A complete seven-day window, not the six-day corpus span.

Verify that acknowledged samples remain exact against the independent reference,
and that duplicates acknowledge while conflicts are rejected. Both Lisa timing
gates must pass before and after each run.

Pre-rollup baseline: ten-client 24h HTTP p95 was 5,513 ms. Maintained
rollups bring it to 398 ms ([rollup evidence](../bench/results/2026-11-15-maintained-rollups/README.md)).
Browser rendering and ingestion have not been measured together.

If a run fails a threshold, profile it and fix only the dominant phase. Each fix
is a separately compared candidate. After three failing runs, record P6 as
blocked, citing the measured distributions and the dominant phase.

The disposable fixture previously hit an Engine command-volume quorum failure
on reopen; see W5. If that recurs, rebuild the fixture from the integrity-checked
corpus once. A second occurrence makes this item blocked on W5.

### W3. P2 after actor sleep (budget: 2 attempts)

P2 requires positive runtime evidence that the actor slept before the measured
request. Engine lifecycle timestamps are often null, and null means unknown,
not asleep. Do not count those samples.

1. Find an Engine signal that positively confirms sleep or eviction for the
   observation actor on the isolated fixture. Examples are a lifecycle
   transition, a constructor invocation or a fresh-process marker.
2. If such a signal exists, collect 200 sleep-confirmed uncached selections
   per range and test p95 <1,500 ms.
3. If the Engine exposes no such signal, record P2's sleep condition as
   **blocked: unobservable**. File the missing capability in Stuff. Do not
   substitute idle time or a forced restart for sleep evidence.

### W4. P7 instrumentation overhead (budget: 1 study)

Run at least five interleaved enabled/disabled rounds on the isolated fixture
under the W2 workload. Measure CPU for Stats separately from the Engine, as
well as request latency. Also verify that a failing collector leaves
application outcomes unchanged.

If the observed spread between rounds of one variant exceeds the threshold
(3% CPU or 5% latency), the result cannot resolve the goal. Record P7 overhead
as **inconclusive at this precision**, with the measured bound. Add rounds only
if the spread is shrinking.

### W5. P9 recovery (budget: 1 investigation, then file)

The isolated lifecycle fixture already verifies idle constructor replacement,
overdue alarms and interrupted replay. The following still need evidence:

- Repeated ordinary restart: at least ten cycles with readiness under 15 s each
  and acknowledged state preserved exactly.
- Idle eviction and interrupted requests, repeated the same way.

The command-volume quorum failure happens inside the Engine before candidate
code runs. Its failed state and logs are preserved. Spend one investigation to
classify it as either Stats misuse or an Engine defect. If it is an Engine
defect, file it in Stuff and record P9 as **blocked on Engine** for the part it
prevents. Engine fixes and upgrades are out of scope here.

### W6. P8 soak analysis (after 2026-11-16 16:41 UTC)

1. Confirm that the sampler finished with no deployment change and no
   unavailable groups.
2. Discard the warmup portion and keep the complete series.
3. Pass requires two things. Over the final 12 hours, queues and actor counts
   show no sustained upward trend. Median Stats RSS stays within 5% of the
   preceding six-hour median. Record traffic and growth in retained data
   alongside these.
4. List the known coverage gaps explicitly: runtime inbox depth, null lifecycle
   timestamps and undelivered application-producer queues. Do not treat them
   as plateaued.

If the run is invalidated, restart it once with a fresh output path. A second
invalidation is a blocker.

### W7. Close the campaign

Deploy any accepted candidates from W2–W5, but only after W6 completes or after
an invalidated soak has been restarted. Re-run the shared health checks and the
P1–P3 smoke on production. Rewrite this Status section so that every goal reads
**pass**, **fail** or **blocked (cause)**, with linked evidence. The campaign
ends there, even if some goals are blocked. Blocked goals become tickets.

## Charter

The campaign runs unattended. The coordinating agent makes every decision itself
and does not wait for owner input. When this document leaves a choice open,
pick the option that preserves the acceptance thresholds and the data
contracts, then record the choice and its reason in Status. Do not ask for
permission or confirmation.

Repository changes and production application deployments are authorized
without further approval, subject to the deploy freeze above. Commit and push
verified slices. Never report unmeasured, deferred or blocked checks as passing.

Preserve canonical data, exact ingest acknowledgments, authentication, bounded
queues and missing-data semantics. Compare exact outputs before accepting a
speedup. Change one attributable mechanism at a time. Keep or reject each
candidate before starting another optimization of the same path.

Use one implementation writer. Independent review and disjoint test work may
run in separately owned worktrees. Retire them after integration. Keep benchmark
artifacts in `bench/results/` once they support a claim. Raw production data and
credentials remain in protected storage on Lisa.

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

A goal fails if it relies on any of the following: a cache hit substituted for
a cold read, an empty response, a missing event, a relaxed durability boundary
or a rejected request. The seven-day target uses the actual retention window.

## Measurement contract

The tenfold fixture is derived from a frozen, checksummed capture of the retained
corpus. It preserves size, operation mix, outcomes and time distribution, and it
assigns independent event identities
([corpus](../bench/results/2026-11-15-tenfold-corpus/README.md)).

Measure complete browser journeys from the Mac over the normal tailnet route,
with a fixed viewport, browser build and device settings. Record request, asset
and response bytes. A journey ends when useful health and every expected chart
show committed data for the new window. Errors and cancellations stay in the
result set.

Cached, awake uncached, actor-sleep and process-start conditions are measured
separately. Never flush Lisa's caches to simulate coldness. Resource figures
separate Stats from the shared Engine.

Comparisons use at least five interleaved rounds. Percentile acceptance needs
at least 200 successful journeys per condition, keeps per-range distributions
separate, and reports counts, spread, p50, p95 and p99. Timing gates must pass
before and after each accepted run. Results from a busy host are diagnostics
only. Profiling runs stay out of timing comparisons.

## Execution boundary

There is no Engine upgrade, credential rotation, durable-data migration, new
database, orchestrator or trace backend. S3 backups remain deferred as STUF-75
P1. Explain candidate API, schema, permission or transaction changes before
implementing them, and verify them with their affected callers.

## Evidence

- [Range and batching measurements](../bench/results/2026-11-14-range-refresh/README.md)
- [Browser journey measurements](../bench/results/2026-11-14-project-journey/README.md)
- [P1 live cached ranges](../bench/results/2026-11-15-live-cached-ranges/README.md)
- [P2 live awake uncached ranges](../bench/results/2026-11-15-live-reads/README.md)
- [P3 live initial-document navigation](../bench/results/2026-11-15-live-navigation/README.md)
- [P4 slow-journey attribution](../bench/results/2026-11-15-journey-coverage/README.md)
- [P7 producer delivery and freshness](../bench/results/2026-11-15-producer-boundaries/README.md)
- [P8 retained browser heap](../bench/results/2026-11-15-browser-retention/README.md)
- [Tenfold corpus](../bench/results/2026-11-15-tenfold-corpus/README.md) and [baseline](../bench/results/2026-11-15-tenfold-baseline/README.md)
- [Ten-client baseline](../bench/results/2026-11-15-ten-client-baseline/README.md)
- [Compact projection](../bench/results/2026-11-15-compact-projection/README.md)
- [Covering-index evidence](../bench/results/2026-11-15-covering-index/README.md)
- [Native cache retention](../bench/results/2026-11-15-native-cache-retention/README.md)
- [Maintained rollups and the soak procedure](../bench/results/2026-11-15-maintained-rollups/README.md)
- [Tenfold fixture tailnet route](../bench/results/2026-11-15-scale-ingress/README.md)
- [Runtime capabilities and gaps](runtime-hardening.md)
- [Production validation and rollback](runtime-hardening-handoff.md)
