# Stats performance campaign handoff

## Resume inspection

The owner requested resumption. A bounded read-only inspection is recorded in
[the resume diagnosis](../bench/results/2026-11-16-resume-diagnosis/README.md).
Production still selected version 24 at 2026-11-16 04:11:55 UTC.
Master now includes runtime changes after this original handoff.
One production inventory sweep succeeded, but the historical failure remains
unresolved. No fixture rebuild, replacement soak or deployment was started.
Further fixture reproduction requires a new explicit scope and attempt budget.

The owner subsequently authorized one fresh isolated Engine/depot attempt.
[That reproduction](../bench/results/2026-11-16-fresh-engine-reproduction/README.md)
failed with filesystem fencing after 25,000 acknowledged rows, without a
memory-limit or OOM event. A single private Engine reopen recovered the same
import count. Exact row contents remain unverified because the pinned API
blocks export during incomplete import. The new container was stopped and
its failed state preserved. The one newly authorized import attempt is used.
No production deployment or replacement soak ran. Configuration versus Engine
behavior remains unresolved, and the original acceptance blockers remain.

## Owner stop and current state

The owner stopped this campaign on 2026-11-16 and requested this handoff for
another coding agent. The owner explicitly relaxed the rule protecting the
failed soak from interruption. The campaign is unfinished. No replacement
soak, production deployment or W7 production smoke was performed in this session.

PID 3384 on Lisa received SIGTERM after its command and output path were
verified. Its terminal record confirms 628 of 1,441 planned samples over
37,656.85 seconds, with `complete: false`. There were 93 unavailable samples:
92 actor-inventory HTTP 503s and one application-health timeout. Thirty-five
unavailable samples occurred after the six-hour warmup. The failures already
prevented acceptance before the owner requested stopping collection.

The read-only observer and its background monitor also exited. No sampler
retry is running. [Stop receipt](../bench/results/2026-11-16-owner-stop/stop.json)
and [analysis](../bench/results/2026-11-16-owner-stop/analysis.json) bind the
preserved input with SHA-256. This series cannot establish 24-hour stability.

Production was inspected at 2026-11-16 03:10 UTC. It still selects
`stats:6cc06db247a3`, Orange deployment version 24, from runtime source
`af4890a3bb5`. The compatible rollback is `stats:03d3d4f1fcb8`, version 23.
No production application or shared Engine was restarted. Changes made during this
session affect benchmark tooling, tests, evidence and documentation.

The prior source of truth is [the campaign](CAMPAIGN-STATS-PERFORMANCE.md).
Its acceptance thresholds remain unchanged. Its unattended queue is suspended
by the owner's stop instruction. Existing budgets are not fresh budgets for
a new agent to reset silently.

## Acceptance state

Passing records below retain their original workload, deployment and browser
qualifications. They do not establish tenfold acceptance.

| Goal | Requirement and state | Evidence or gap |
| --- | --- | --- |
| P1 | Cached selection p95 <50 ms and p99 <100 ms, with zero summary reads: **pass for the recorded current-corpus cohort** | [200 samples per range](../bench/results/2026-11-15-live-cached-ranges/README.md). Tenfold repeat is blocked with P6 |
| P2 | Awake uncached 1h/6h/24h p95 <750 ms and 7d <2 s: **recorded cohort passes**. After-sleep p95 <1.5 s: **blocked, sleep unobservable** | [Awake evidence](../bench/results/2026-11-15-live-reads/README.md), Stuff STUF-86 |
| P3 | Useful health p95 <1 s and complete charts <2 s: **recorded default-1h navigation cohort passes** | [200 new documents](../bench/results/2026-11-15-live-navigation/README.md), with normal HTTP asset caching. Tenfold repeat is blocked |
| P4 | Correlated dominant-phase attribution for >=99% of delivered journeys over 1 s: **pass for the observed cohort** | [17 of 17](../bench/results/2026-11-15-journey-coverage/README.md). No population or lossless-delivery guarantee |
| P5 | Healthy, failing, slow, stale and post-deployment state, onset context and working target within 10 s: **local scripted cases pass on desktop and mobile** | [14 current-checkout cases](../bench/results/2026-11-16-closeout-local/README.md), unchanged 10-second cap, no retries or skips |
| P6 | P1–P3 at 10x frozen corpus, ten browsers and representative ingestion, exact outputs: **blocked on fixture preparation** | No combined run. Import HTTP 500 and native volume fencing. Stuff STUF-87 |
| P7 | Queryable p95 <5 s: **recorded paced cohort passes**. Instrumentation CPU <3%, latency <5%, collector-failure outcome parity: **unmeasured and blocked** | [200 of 200 observations](../bench/results/2026-11-15-producer-boundaries/README.md). Stats STA-128 retains the overhead study |
| P8 | Retained heap growth <5 MiB after 200 cycles: **recorded browser series passes**. Native 24-hour plateau: **blocked by invalid, incomplete collection** | [527,136 bytes retained growth](../bench/results/2026-11-15-browser-retention/README.md). Stopped soak has missing groups and incomplete temporal windows. Stuff STUF-88 |
| P9 | Ten repeated restart, idle, overdue-alarm and interrupted-request recoveries preserve acknowledged state; ordinary readiness <15 s: **not established** | Earlier lifecycle component tests remain useful. Repeated native acceptance is blocked by the unclassified volume failure, STUF-87 |

## Blocker 1: native fixture preparation and recovery

The target corpus has 203,950 independent event identities. Its raw source and
integrity-checked tenfold expansion remain protected on Lisa. The isolated
fixture is behind `stats-next.17166969.xyz` and container
`stats-perf-scale-server`. That container was still running at handoff, but
its preparation Worker exited after failure. A running container does not
establish a usable HTTP fixture or a complete imported corpus.

Observed failures, with paths relative to protected
`/home/josh/.work/stats-perf-campaign/` on Lisa:

| State or log | Observation |
| --- | --- |
| `current-scale-20261115/` and `current-scale-prepare.log` | Import HTTP 500, plain `Internal Server Error`; last acknowledged import 21,500 rows. Snapshot has no memory-limit or OOM events |
| `production-scale-20261115/` and `production-scale-resume.log` | Resumed from exactly 68,000 acknowledged rows, later stopped at 112,500. Memory-limit events occurred, with no OOM kill |
| `campaign-rebuild-20261115/` and `campaign-rebuild-20261115.log` | This session's single allowed rebuild stopped at 70,500 acknowledged rows. Snapshot has 1,514 cumulative memory-limit events and no OOM kill |
| `production-engine-20261115/engine-stdout.log` | `QuorumUnavailable { token: None }` at 18:03:23 UTC on November 15. Volume fencing with `staged_write_abort_failed` at 18:03:30, 18:18:35 and 19:08:47 |
| `production-engine-20261115/engine-stderr.log` | Also contains a missing log-directory free-space probe error |

The rebuild used a fresh namespace, `stats-scale-rebuild-20261115`, on the
**existing private Engine**, with two aggregate CPUs, a 3 GiB container limit
and 250 ms pacing between 500-row import pages. It did not use a fresh Engine
process or depot. The retained failed states and shared private-Engine memory
are a setup caveat for the next investigation. The evidence does not prove
whether the root cause is Stats misuse, configuration/resource limits or an
Engine defect. Actor-list responses also returned the same actor ID in two
fixture namespaces. That observation needs classification rather than an
assumption about namespace isolation.

The private Engine binary SHA-256 is
`0b6e8c031ce2d2d3259b540a4ae55c6f8d4bb367001406110ce5dc62bcd7357f`.
The fixture uses pinned production-image bundles. The full account is in the
[preparation review](../bench/results/2026-11-15-scale-prep-review/README.md).
Stuff STUF-87 is P1, assumed for the blocked durable recovery path. Production
data loss was not demonstrated.

No full W2 workload ran. Its three full-run allowance was unused, but the
single allowed rebuild was used. W5's one investigation was used without a
definitive root-cause classification. Engine repair and upgrades were outside
this campaign. A next task must define the scope and budget for further work
instead of calling another rebuild part of an unused full timing run.

## Blocker 2: sleep cannot be positively identified

Two observability checks returned null `sleep_ts`, `start_ts` and
`connectable_ts` for the private observation actor. The actor-name endpoint
adds no transition evidence. `ObservationStore` exposes no constructor
generation through its existing health interface.

No sleep-confirmed latency samples were collected. Elapsed idle time, null
timestamps and forced restart must not substitute for natural sleep evidence.
Stuff STUF-86, P2 assumed, requests a positive per-actor sleep/wake or
constructor-generation signal. This session counted two API/source checks
against the two-attempt W3 budget. No sleep-confirmed workload ran.

## Blocker 3: overhead and collector failure parity are unmeasured

W4 requires at least five interleaved enabled/disabled rounds under the
complete W2 workload. It must separate Stats CPU from Engine CPU and measure
request latency. It must also prove that collector failure leaves application
outcomes unchanged.

No valid overhead study ran because the complete fixture was unavailable.
There is no measured overhead bound or precision estimate. Do not rename
this result an overhead pass or a measured noise-floor failure. Stats STA-128,
P2 assumed, retains the study and its unchanged 3% CPU and 5% latency limits.

## Blocker 4: soak availability and missing resource coverage

The stopped series is preserved at
`/home/josh/.work/stats-perf-campaign/maintained-rollup-soak-v2.jsonl`.
Its stopped PID must not be reused from an old PID file for any later signal.
The terminal record and process absence, not the old PID file, establish stop.

Actor inventory failed repeatedly with HTTP 503. One application-health
collection timed out. Stuff STUF-88, P2 assumed, tracks this availability gap.
It is an observed diagnostic failure, not a classified production outage or
proof of data loss.

Independent coverage gaps remain even if collection availability is repaired:

- Runtime inbox depth is unavailable.
- Null lifecycle timestamps do not establish actor state.
- Undelivered application-producer queues are not observed by delivered events.

The campaign allowed one invalidation restart after the active run. None was
started in this session. An older pre-handoff trial also exists and was invalid
for a different classification error. Do not confuse historical trials with
new attempts or silently reset their budget. A replacement run alone does not
repair missing metrics or repeated HTTP 503s.

`bench/analyze-native-soak.py` is read-only and creates output exclusively.
Its seven regression tests pass. It requires complete collection, deployment
and process identity, explicit coverage metadata and available groups before
assessing the required RSS windows and trends. It compares hours 6–12 with
hours 12–24 and retains explicit coverage gaps. Missing identity formerly
produced false passes and is now rejected. Use the exact preserved series,
not a filtered subset that drops failed samples.

## Remaining closeout work and workspace

W7 production health and P1–P3 browser smoke were not run in this session.
The final closed-campaign status table and retirement of the six `park/*`
branches are also unfinished. The owner stopped the session before closeout.
The handoff is not a claim that the optimization campaign achieved its goals.

Completed work is pushed to `origin/master`. This handoff follows
`9526c929f56`; the important earlier slices are `b15839f2a32` for reviewed
private fixture tooling, `d4a433731fa` for soak analysis, `e8e4388ef6f` for
measured-failure classification, and `eb69efb7fb0` for missing-identity rejection.
The [local audit](../bench/results/2026-11-16-closeout-local/README.md) links
the existing accepted cohorts and records the current P5 test execution.

Verification during this session includes two non-skipped Linux fixture
regressions, seven analyzer tests, 14 local overview cases and pinned-Node
type-aware lint. The full `make test` and release `make check` were not run.

The canonical checkout retains an unstaged `pnpm-lock.yaml` change. Its origin
was not established. It was not committed or reverted. The local audit records
its checksum. Completed Stats task worktrees were retired. Unrelated `btree`,
`ci-pnpm`, `upgrade-*` and other owner worktrees remain untouched.

One completed ticket checkout remains at
`/Users/josh/repos/laputa-systems/stuff/.work/wt/stats-campaign-blockers`,
branch `fix/stats-sleep-evidence`, head `2a82b58`. Its tracked tree is clean.
It contains ignored `.work/tmp/stats-sleep-ticket.json` from ticket allocation.
STUF-86, STUF-87 and STUF-88 are pushed to Stuff `origin/main`; its canonical
checkout may not yet contain those remote commits. Failed native fixture
state and the private container remain available for investigation.

All raw production data and credentials remain in protected Lisa storage.
S3 backups stay deferred as STUF-75 P1. Preserve exact acknowledgments,
canonical JSON identity, authentication, bounded queues and missing-data
semantics in any follow-up. Do not restart the shared Engine for this work.

This session over-polled an already-invalid run. Those heartbeats added no
qualifying acceptance evidence. The owner ended the run instead of continuing
to wait under the old protection rule.

The next useful assignment is bounded diagnosis of fixture/configuration
versus Engine behavior and collection availability, followed by an explicitly
scoped acceptance attempt. Another period of polling a known-invalid run
cannot resolve these blockers.
