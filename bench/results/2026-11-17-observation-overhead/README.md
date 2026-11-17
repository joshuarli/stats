# Observation overhead rehearsal

STA-128's ten-browser functional rehearsal passes on the private repaired
Engine and a copy of the verified 203,950-event fixture. This is diagnostic
evidence. It establishes no CPU or latency bound.

The Engine is the release candidate from merged Stuff PR39, binary SHA-256
`611b08f609d625ad5379c3b0801f23fc76ab4e17cc3ee0210ba608bf53ae1b01`.
The application is the frozen `stats:6cc06db247a3` image. The receipt retains
both Worker digests and the corpus checksum.

All ten real browser sessions complete each condition:

| Condition | Uncached reads | Cached selections | Exact ingested events |
| --- | ---: | ---: | ---: |
| Instrumentation disabled | 40 | 40 | 1,024 |
| Instrumentation enabled, 10% native sampling | 40 | 40 | 1,024 |
| Instrumentation enabled, collector HTTP 503 | 40 | 40 | 1,024 |

Every uncached response matches the independent complete corpus summary.
Rendered windows, populated charts and visible counts match the response.
Cached selections issue no summary requests. Every acknowledged ingested
event matches its stored content. Each condition also verifies a 64-event
duplicate batch, changed-duplicate HTTP 409 and malformed-input HTTP 400.

The enabled measurement interval records 105 received and 105 sent native
observations. The later verification receipt has 140 admitted, 126 sent and
14 queued, with zero drops, retries, invalid spans or rejected requests.
These counters do not establish native exporter completeness.

The failed collector receives six export attempts and returns HTTP 503.
All browser reads, exact ingested events and application error outcomes
remain correct. The receipt retains this condition separately from overhead.

## Qualifications

Both Mac host gates pass. Both Lisa host gates return 75. The historical
fixture uses a frozen client clock and retention-clamped windows through an
authenticated SSH tunnel. This is one diagnostic pair, with ten uncached
journeys per range. It is not the required five-pair study, a full seven-day
campaign run, or ordinary tailnet-ingress acceptance.

[The complete rehearsal receipt](rehearsal.json) retains failures, browser
samples, exact response digests, producer counters and gate outcomes. Its
embedded analysis remains inconclusive. Do not use its diagnostic timings
as an overhead estimate.

The first rehearsal preceded subsequent changes to per-round host gates, per-range
p95 analysis, cached-output comparisons, export draining, source receipts and
startup cancellation. Final browser qualification for those changes remains
pending at that point. Their analysis and process-cleanup regressions pass separately.

The [fresh rehearsal](fresh-rehearsal.json) subsequently verifies those changes
with all twelve per-round host gates passing and zero application delivery
failures. Its collector-failure case retains seven rejected exports with exact
application outcomes. It is still a one-pair functional rehearsal.

The [first full study](failed-study.json) stops in its initial disabled round.
Eight browsers complete 20 cycles; two report incomplete journeys, after 38
and 35 reads respectively. All four host gates pass. All completed responses
match the reference. The cohort is retained in full, with no overhead estimate.
Its original generic failure does not establish the cause. The bounded
diagnostic reproduction captures failing-event and response metadata.

## Verification and reproduction

Seven Linux container regressions pass without skips, covering fixture
safety, overhead acceptance, Linux CPU parsing, startup cancellation and
private storage-root enforcement. The cancellation regression rejects an unauthenticated stop,
then proves an authenticated stop works during startup and removes both
owned processes. A hand fault rejecting that stop with HTTP 409 fails the
intended assertion. The source is restored and the tests pass.

Run these tests in the pinned Stats image with read-only sources at `/source`
and writable executable scratch at `/bench`. The fake Engine executable in
the cancellation regression requires the scratch mount's `exec` option:

```sh
node --test /source/bench/observation-overhead-analysis.test.mjs /source/bench/observation-overhead-server.test.mjs /source/bench/native-scale-engine.test.mjs /source/bench/native-scale-fixture.test.mjs
```

Pinned-Node syntax checks and `make lint` pass. Full repository tests and the
release gate were not run. The separately recorded insertion optimization changes observation source;
there is no production deployment.
The [benchmark instructions](../../README.md#native-observation-overhead)
describe the server, protected credentials and driver. The original repaired
depot remains unchanged. The copied rehearsal container is stopped.

The single fresh preparation allowed in
[the resumption record](../../../docs/STATS-PERFORMANCE-RESUMPTION.md)
completed with all 203,950 events and exact reference checks.
[The preparation receipt](fresh-preparation.json) and
[fixture proof](fresh-fixture.json) preserve the result. Full overhead and
campaign acceptance remain pending. Its seven-day response is still clamped
against the import's fixed historical endpoint.


## Diagnostic completion and recovery

[The full-length diagnostic](full-diagnostic.json) completes 800 uncached and
800 cached selections in each variant without reproducing the initial browser
failures. Its enabled application delivery fails 674 times. Browser counters
also retain disabled-document state across hash-only navigation. Distinct
variant/round query strings now force a new document; a real-browser regression
proves that reset. This does not explain the original incomplete journeys.

[The profiled diagnostic](cpu-profile-workload.json) subsequently completes five
cycles per browser with exact application outcomes, 400 successful enabled UI
posts and no UI drops, pending posts or application delivery failures. It is
excluded from timing acceptance. Native profile stacks show synchronous
SQLite transaction boundaries; sampled stack weight can include native waits.
The resulting [insertion optimization](../2026-11-17-native-ingest-batching/README.md)
has separate component evidence, with no full overhead conclusion.

[The recovery cohort](engine-recovery.json) retains nine exact gated recoveries
and the tenth TERM failure. It compares every canonical event-table row and
Installation manifest, and checks that application process identities survive.
The tenth Engine exits 1 with a dependent-failure lease fence before restart.
Ten-cycle acceptance fails. The initial trigger and post-failure data state
remain unproven. Stuff STUF-90 retains the source investigation.

The failed `fresh/` depot is stopped and preserved on Lisa. Copy it and rewrite
both storage paths before any further reopen. Do not reimport, reset the
attempt ledger or replace the failed evidence. The protected raw CPU profiles
remain under `fresh/cpu-enabled-0/` and `fresh/cpu-disabled-0/` there. The
committed workload receipts and source digests preserve conclusions without
requiring those scratch profiles. Use the original attempt conditions in
[the resumption record](../../../docs/STATS-PERFORMANCE-RESUMPTION.md).
