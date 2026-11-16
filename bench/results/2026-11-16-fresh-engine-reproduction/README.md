# Fresh private Engine reproduction

The owner authorized one fresh isolated Engine and depot reproduction after
the [read-only diagnosis](../2026-11-16-resume-diagnosis/README.md).
That single attempt reproduced the import failure. No second import ran.
No production application or shared Engine was restarted or reconfigured.
No performance acceptance or timing claim follows from this diagnostic run.

## Configuration

The new container was `stats-perf-resume-20261116`, with external networking
disabled, two CPUs, a 3 GiB memory limit and no additional swap allowance.
It used the existing image by immutable image ID:
`sha256:9fbc7f1418318a75a32a2273b10ed8a6794bdce6821fec8fcc96b6f61f6408a8`.
The Engine binary SHA-256 remained
`0b6e8c031ce2d2d3259b540a4ae55c6f8d4bb367001406110ce5dc62bcd7357f`.

The Engine configuration retained the previous private configuration except
for new storage paths. Its depot was empty at startup. Credentials were fresh.
The Engine and application bundles were unchanged. Preparation used namespace
`stats-scale-resume-20261116`, node version 24, the frozen 203,950-event corpus,
500-row pages and 250 ms pacing. The attempt deadline was ten minutes.
The existing `native-scale-engine.mjs` and `native-scale-fixture.mjs` owned
their respective child processes. Preparation exited through its failure
cleanup before the deadline. A separate bounded recovery probe stopped its
Worker process group after reading progress.

The preserved prior failed fixtures were not imported, reopened or modified.
The new container mounted the existing protected benchmark directory and used
only new Engine and fixture directories for mutable runtime state.

## Failure and recovery

At 2026-11-16 04:16:08.100 UTC, the new Engine logged
`depot filesystem fenced; its owner must reopen the volume`, with reason
`staged_write_abort_failed`. Preparation failed with HTTP 500 without JSON
on `POST /api/v1/admin/objects/observe:stats/import/rows`.
Its last acknowledged import count was 25,000 rows. The driver exited 1
at 04:16:09.371 UTC.

The failure snapshot reports 2,018,594,816 bytes of container memory,
zero memory-limit events, zero OOM events and zero OOM kills.
This reproduction shows that retained failed depot state and cgroup
memory-limit events are not necessary conditions for this occurrence.
It does not exclude other resource limits, storage behavior or configuration
as the underlying cause. The new log did not report the earlier explicit
`QuorumUnavailable` message. The matching demonstrated symptom is fencing.

Only the new container was stopped gracefully and restarted, reopening its
private depot. The recovery probe started the same pinned Worker bundles
and made an authenticated GET to the import-progress endpoint.
It returned HTTP 200, state `importing`, and exactly 25,000 imported event
rows. All other import table progress counts were zero.
No acknowledged-count regression was observed in this single reopen.

Exact row equality is **unverified**. The pinned snapshot API requires state
`fenced` for export, while `setFence` rejects state `importing`.
The probe did not alter those rules, finish the incomplete import, or submit
another import page. Count preservation is not a substitute for comparing
canonical stored JSON. Ten repeated recovery cycles and P9 acceptance remain
unestablished.

The new container was stopped after evidence capture. Its depot, fixture,
credentials and logs remain in protected Lisa storage. No sampler was started.
The failed combined fixture still blocks P6 and the P7 overhead study.
The existing STUF-87 investigation now has a reproduction without prior
failed depot state or observed cgroup memory-limit pressure. Configuration
versus Engine implementation remains unresolved. Engine repair and upgrades
remain outside this authorization.

## Evidence

[The receipt](evidence.json) contains actual container limits, image identity,
the attempt outcome, failure counters, recovery result and SHA-256 bindings
for the protected inputs, tools and logs. Raw events and credentials remain
on Lisa under `/home/josh/.work/stats-perf-campaign/`:

- `resume-engine-20261116/`: private Engine binary, configuration, depot and logs.
- `resume-fixture-20261116/`: import plan, acknowledgment, failure and recovery receipts.
- `resume-attempt-20261116.log`: preparation output and terminal failure.
- `resume-recover-20261116.mjs`: bounded recovery probe.

Verification consists of the actual failed Linux preparation, successful
post-reopen progress request, recovery-probe syntax check and documentation
diff checks. No source implementation changed. Full tests and release gates
were not run, and no benchmark improvement is claimed.
