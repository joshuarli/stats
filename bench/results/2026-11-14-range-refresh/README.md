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
