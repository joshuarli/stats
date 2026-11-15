# Range refresh diagnosis

The production browser waited 11.66 seconds for a 37,949-byte application
summary. Time to first byte was 11.65 seconds. Another live read decoded
17,365 events' summary in 11.9 ms after its response headers arrived.
These are diagnostic observations under shared production load, not controlled
before/after speedup measurements.

Native samples contain a 10.832-second ObservationStore invocation near the
slow read and much shorter same-trace SQLite spans. This narrows the search;
native spans do not identify the logical method or account for all runtime
waits. The private raw capture remains outside the repository.

## Cancelled range reads

A deterministic browser regression holds a summary response across twenty
seconds of virtual time. Before the fix, both Overview and Platform issue a
third request instead of completing the second. The fifteen-second live tick
recomputes an object-valued effect input even when its five-minute refresh key
has not changed. Cleanup cancels the pending request.

Memoizing the refresh key removes those invalidations. Both desktop and mobile
regressions pass, as do the existing Platform checks: ten browser cases in total.
Range selection and manual Refresh still start reads. The fix is deployed as
`stats:6b6398c7e44e`, Orange node version 12; production deployment smoke and
marker delivery pass. This removes avoidable cancellations, not the server wait.

## Per-request timing

Summary responses retain the same JSON and gain authenticated `Server-Timing`
fields. The existing HTTP event carries corresponding integer microseconds and
the requested window length. No additional observation event is emitted.

| Header | Existing HTTP-event work | Meaning |
| --- | --- | --- |
| `app-query` | `query_us` | Aggregate SQL call and result materialization |
| `app-issues` | `issues_us` | Current open-issue SQL call |
| `app-read` | `read_us` | Complete synchronous actor read |
| `app-store` | `store_us` | Observation Worker's actor call, including waits and transport |
| `app-encode` | `encode_us` | Observation Worker response encoding |
| `app-total` | Existing `durationMs` | Stats response-header wall time |

These are elapsed times, not CPU times. Nested durations overlap and must not
be added. There are no actor identifiers, SQL, raw URLs or credentials in the
new fields. Invalid or unavailable header fields remain absent.

The development Mac comparison uses the same 1,847 captured events as the prior
read-performance record, Node 26.13.1 and complete loopback HTTP reads. Five
interleaved rounds of ten requests per side preserve every response. Baseline
median round mean is 3.789 ms (3.738–4.223); timed reads are 3.783 ms
(3.748–4.013). The difference is within the observed spread: no measurable
overhead. Both host load gates pass. Combined harness RSS is 146,178,048 bytes;
this is not an isolated per-query allocation measurement. JSON remains 37,398
bytes. Instrumented headers add a small fixed set of numeric durations; the
existing observation event gains at most six numeric work fields.

## Repeated range selection

The component retains five successful summaries per selection and refresh
generation. Manual refresh and the five-minute generation invalidate reuse.
Cached summaries keep their original timestamp. Detail payloads are excluded.
An interrupted replacement still revalidates, preserving the existing behavior.

The live `stats:a7528f3bdc75` browser loads 1h, 6h and 24h once. Five rounds of
those three selections add zero summary requests. All three charts remain
visible. This verifies removed network work. Host load gates failed during
the live check, so no browser latency claim is made from that check.
The focused browser suites pass on desktop and mobile, including manual
refresh, generation changes, failed reads and interrupted replacements.

First reads still require server work. Stored HTTP events now contain the
paired timings. One 31,439 ms response has 31,390 ms in `app-store` and
2,851 ms in `app-read`. Other slow reads spend most of their time in
`app-query`. These are production diagnostics under shared load.

## Batched self-observation

The native comparison uses the same 1,847 captured events, pinned Orange and
Rivet closure, and filesystem-backed local Engine. Each round restarts the
runtime. The workload issues sixteen concurrent capabilities requests, then
completes a summary HTTP read. Both variants retain identical summaries and
all sixteen HTTP events. Five interleaved comparisons have zero failures.
Both timing gates pass.

| Measurement | Individual posts | Bounded producer |
| --- | --- | --- |
| Median request burst plus summary | 146.87 ms | 58.05 ms |
| Range across five rounds | 133.56–198.14 ms | 52.08–65.04 ms |
| Ingestion batches for sixteen events | 16 | 1 |
| Median time until events are readable | 183.81 ms | 1,056.57 ms |
| Process tree RSS range | 875,408–893,040 KiB | 875,616–891,648 KiB |
| Packaged Stats Worker bundle | 960 KiB | 1,012 KiB |

The improvement comes from removing separate actor ingestion turns before
the read. The SQL itself still reads the same data. The workload models a
page request burst, rather than a full browser navigation. Lisa's slower disk
and shared workloads require independent live validation.

The tradeoff is roughly one second of observation delay. Each producer holds
at most 128 queued events plus one active batch of at most 64. Overflow drops
oldest events and updates delivery counters. Runtime termination can lose
queued events. `waitUntil` owns the shared flush, while HTTP responses proceed.
The native test proves cross-request batching through the actual binding.
Saturation, bounded retries, duplicate acknowledgments and auth rejection
also pass. The complete native suite passes all five cases.

`native-batching.json` preserves the result rows. To repeat the comparison,
generate separate packaged production descriptors and bundles for each revision
in fresh directories under `.work/tmp`. Supply the protected event capture:

```sh
node bench/results/2026-11-14-range-refresh/native-batching.mjs \
  --source "$CAPTURE" --baseline "$BASELINE" --candidate "$CANDIDATE"
```

The harness seeds disposable state and preserves exact response equality.
Use `--prepared` only to rerun against fixtures already seeded by the harness.
The raw production capture is deliberately excluded from this repository.

## Rejected expression index

A covering expression index removed payload-table access in Node's query plan.
Native testing against 14,776 captured events did not establish a cold-read
benefit. Five interleaved cold reads had overlapping spreads: baseline
191–1,273 ms, candidate 385–1,336 ms. Median cold reads were 195 ms and
477 ms. Warm medians were 36.9 ms and 33.4 ms.

The fixture footprint grew from 134,096 to 303,880 KiB, including Engine
artifacts. This is not an isolated index-size measurement. The small warm
benefit does not justify the unproven cold behavior and storage cost.
The index was removed before deployment. Private evidence and its patch are
preserved with the Mac's protected campaign backup.
