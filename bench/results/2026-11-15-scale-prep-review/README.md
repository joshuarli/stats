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
