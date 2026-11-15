# Private fixture preparation review

Branch `wip/native-scale-prep`, revision `a98fe56480b`, was reviewed and
integrated as `b15839f2a32`. It adds private-Engine preparation, explicit image
and bundle provenance, protected credential loading, import pacing and actor
readiness checks. It changes benchmark tooling only.

The two Node regression tests ran inside `stats-perf-scale-server` on Lisa
with Node 26.13.1: two passed, zero skipped. They verify early Engine exit
terminates without exposing credentials and production namespace preparation
is rejected before creating state. Remote script SHA-256 values match the
reviewed source:

- `native-scale-engine.mjs`: `d5351cde34a74a49eaeb0f9f7dd527c3ea9bf599cb1506ff405d8257d7fbcb62`
- `native-scale-fixture.mjs`: `fcb412f8062374c6ccb38e69c7eb29c8acc3cdf580b88a886e8c0b9aa530170a`

`make lint` passes with the repository-pinned Node 26.13.1. The full test suite
was not run. No performance acceptance run or speedup is claimed.

## Preserved preparation failures

Read-only inspection at approximately 2026-11-15 19:02–19:08 UTC found:

- `current-scale-prepare.log`: import failed with HTTP 500, plain
  `Internal Server Error`; last acknowledged import was 21,500 rows.
  Its resource snapshot reports 2,258,325,504 bytes and no memory-limit or
  OOM events.
- `production-scale-resume.log`: resumed from exactly 68,000 acknowledged
  rows, later failed with the same HTTP response; last acknowledged import
  was 112,500 rows. Its snapshot reports 3,144,486,912 bytes, 808 memory-limit
  events and zero OOM kills. This is resource pressure evidence, not proof
  of the cause of the HTTP failure.
- Private Engine stdout at `production-engine-20261115/engine-stdout.log`
  records `volume log mutation failed: QuorumUnavailable { token: None }`
  at 18:03:23 UTC, followed by filesystem fencing with
  `reason=staged_write_abort_failed` at 18:03:30 and 18:18:35 UTC.
  Stderr also contains a missing log-directory free-space probe error.

All paths above are relative to protected
`/home/josh/.work/stats-perf-campaign/` on Lisa. Raw files and credentials
remain there. These observations do not establish whether configuration,
Stats usage or an Engine defect caused the failure. W5 classification remains
necessary. No rebuild or full W2 workload was started during this review;
the three full-run budget is unchanged.

The production soak PID 3384 was observed alive. Production was not deployed,
the shared Engine was not restarted, and the sampler was not modified.

## W3 sleep observability

Two checks of the isolated Engine actor-list endpoint returned the observation
actor with null `sleep_ts`, `start_ts` and `connectable_ts`. The actor names
endpoint exposes names and metadata only. Source inspection of
`cloudflare/src/observe/cloudflare/store-object.ts` confirms the constructor
does not expose a generation marker; `health()` returns service health rather
than constructor identity. Neither check produced positive sleep evidence.
No sleep latency samples were accepted and no idle interval was substituted.

W3 is blocked: unobservable. Stuff STUF-86 (P2, assumed) tracks a positive
sleep/wake signal, committed to Stuff main at `d28e47c`. A concurrent ticket
allocation required replacing the initial branch-only ticket ID before
integration. Awake P2 evidence is unchanged.

## Single rebuild result

The allowed rebuild started on November 15 in the existing isolated container,
using namespace `stats-scale-rebuild-20261115` and protected root
`/bench/campaign-rebuild-20261115`. It uses the pinned production image's
bundles and the checksummed 203,950-event corpus with 250 ms pacing between
500-row import pages. Prior failed states remain intact. Driver and log are
`rebuild-scale-once.mjs` and `campaign-rebuild-20261115.log` under the protected
host scratch directory. No additional rebuild is authorized by this record.
The driver exited 1 with HTTP 500 and plain `Internal Server Error` after
70,500 acknowledged rows. At 19:08:47.884 UTC the private Engine logged
another filesystem fence with `reason=staged_write_abort_failed`. The failure
resource snapshot reports 3,175,346,176 bytes, 1,514 cumulative memory-limit
events and zero OOM kills. Counts are cumulative container counters, not
per-attempt deltas. The complete fixture was not prepared, so no full timing
run or exact-output acceptance comparison was possible.

W2 is blocked on fixture durability after its allowed single rebuild. There
will be no further rebuild in this campaign. W4 is also blocked: its required
combined W2 workload cannot run on an incomplete fixture. No overhead samples,
CPU bound, latency bound or collector-failure acceptance is claimed.

W5's single investigation localizes the observed failure to Engine volume
fencing, rather than a Stats validation rejection. It does not prove the
underlying cause is an Engine defect rather than configuration or resource
limits. Repeated ordinary restart and interrupted-request recovery acceptance
remain blocked. Stuff STUF-87 (P1, assumed) carries the logs, binary provenance,
resource caveat and required recovery proof. Engine repair remains outside
this campaign. Existing isolated lifecycle evidence is retained, without
promoting it to repeated native recovery acceptance.
