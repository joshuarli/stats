# Tenfold native baseline

Verdict: the 203,950-event fixture preserves summary correctness, but its wide
reads exceed the awake latency target. This is a native component baseline,
not browser or 200-sample percentile acceptance.

The production image `stats:1ea3e6af2dc3` runs two Workers and its pinned embedded
Engine in a disposable Lisa container: two CPUs, 3 GiB memory, filesystem state,
no published ports and no production Engine access. Application instrumentation
is disabled. The bulk loader is absent during timing; a small separate client
uses real HTTP and consumes every response. Both Lisa timing gates exit 0.

| Historical window | Events | Repeated HTTP median (range), five reads |
| --- | ---: | ---: |
| 1h | 10,860 | 105.8 ms (79.3–126.1) |
| 6h | 74,630 | 377.1 ms (364.6–490.9) |
| 24h | 198,400 | 955.2 ms (917.5–974.5) |
| 144h, covering the full corpus | 203,950 | 957.8 ms (901.4–1,025.2) |

The first 24h request after process startup takes 12.1 seconds, including
12.09 seconds of aggregate SQL. The following full-corpus request benefits from
those reads. These conditions are separate from the repeated series. They are
not positive actor-sleep or operating-system disk-cache evidence. The fixture
contains about 25 hours of source activity; the full-corpus request is six days,
not seven-day acceptance. [reads.json](reads.json) contains all 24 responses'
timings, counts and hashes. Every repeated full response equals its initial one.

[preparation.json](preparation.json) records the source and fixture checksums,
uniform timestamp shift, complete independent summary comparisons, canonical
table digest, 64 exact duplicate acknowledgments, changed-duplicate rejection
and identical summaries across another restart. IDs are independently assigned
and all source event fields remain unchanged except for the common time shift.
The private [fixture generator](../../scale-application-corpus.mjs) preserves
exact event bytes before that shift.

Bulk import encounters internal responses associated with native volume-log
backpressure and a subsequent SQLite fence. Resuming retains all 189,000
previously acknowledged rows; final import verifies every table digest. Cgroup
counters show memory pressure and CPU throttling without an OOM kill. These
observations do not establish the cause of the original quorum refusal or prove
uninterrupted bulk-restore reliability. The private fixture also needs stale
embedded-Engine PID metadata checked across container PID namespaces.

The loader and reader are [native-scale-fixture.mjs](../../native-scale-fixture.mjs)
and [native-scale-reads.mjs](../../native-scale-reads.mjs). They require the
protected corpus and the frozen image's `/app` layout. Current reader trials
first verify actor readiness through the maintenance-state route; this older
baseline used application health only. A subsequent comparison exposed a 503
before the actor was ready, so that comparison is invalid and must be rerun
with the same actor-readiness protocol for both variants.
