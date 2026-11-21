# Private TERM fence diagnosis

The investigation resumes STUF-90 without reopening the failed original
depot or starting another import. The original tenth-cycle trigger remains
unclassified. No new overhead or recovery acceptance follows from this record.

## Attempt ledger

[The attempt ledger](attempt-ledger.json) retains the consumed fresh-import
and overhead-study allowances. The original browser failures occur in clients
6 and 9, after 38 and 35 reads. Their receipts contain no failed-phase event
or response metadata. Completed response digests cannot distinguish an HTTP
failure, cancellation, or missing rendered data for the next selection.
Those failures therefore remain unclassified. Further accepted overhead
comparisons need a new owner allowance.

A later re-read of the cohort, recorded in
[the attempt ledger](attempt-ledger.json), finds that both failures follow the
slowest uncached read retained for that browser: 8,716 ms for client 6 and
8,712 ms for client 9, both HTTP 200 with an exact digest. The error names the
next uncached range, so the failing phase produced no sample. All four host
gates, exact ingestion and collector counters were clean. The recorded probe
did not retain `failedPhase`, so the cause is still unclassified and no code
change follows. The current probe retains that metadata and the current driver
uses distinct per-round documents.

## Diagnostic source

[The diagnostic patch](diagnostic.patch) applies to Engine source
`f68e0732f44c1d0ec64e96dc425f585eeef8c255`. It logs every source path that
requests a dependent-failure fence. It preserves the worker heartbeat guard
and all fence decisions. The patch SHA-256 is
`ad1177688905ed5a77976d7a18a3f96b756f3d9d8b8880f3d4aaaa9ade21cfb3`.

The exact-source dev build succeeds with Rust 1.99.0 in the attested builder
image, using four build jobs and an 8 GiB limit. Its stripped binary SHA-256 is
`9401945895cd5b21650c28c77851a664819de6a3cc3370083f4dfdba3d8b7b03`.
Build commands retain the existing `--cfg tokio_unstable` setting and locked,
offline Cargo resolution. No runtime dependency or persisted format changes.

The exact-source release build also succeeds under those build settings.
Its stripped binary SHA-256 is
`3be56331ab498859c66a85e19b140363cd0f005994abb249519302700f7a314e`.
The release diagnostic retains the same explicit disk capacities and request
deadlines as the dev setup. Neither build is deployed to production.

## Protected fixture and setup failures

The stopped original root remains on Lisa at
`/home/josh/.work/stats-perf-campaign/sta128-20261117/fresh/`.
Its Engine log SHA-256 remains
`1408bf902b4119c9f0fa0632cd2069ccc1ef2f93c6e8992ccbd91b2c28a5c6de`.
The diagnostic root is a complete copy named `stuf90-diagnostic-20261117`
beside it. Both Engine storage paths and copied descriptor paths name that
copy. The container mounts only the copy and read-only benchmark sources.

An initial setup binary was built from an incomplete source copy. It fails
disk preflight before opening the depot and is rejected as provenance evidence.
The source is then replaced with the exact recorded revision plus the
diagnostic patch before any successful open. The rejected binary SHA-256 is
`6a19542945a9736f3505ef975311d725e32048046c0c6ee27b4d1a87ade27e87`.

Lisa reports 15.5 GiB available on a 464 GiB filesystem. Automatic Engine
sizing refuses to start below its ten-percent reserve. The diagnostic copy
uses the supported explicit capacities: a 1 GiB log and a 256 MiB disk cache.
The container retains two CPUs and 3 GiB. These capacity changes and the dev
build prevent performance comparisons with the accepted release cohorts.

An invalid control-route setup probe stops the first exact-source dev
process. Its cleanup exits normally. That stop is not a requested diagnostic
cycle and does not reproduce the original failure.

[The dev setup receipt](dev-setup.json) records a subsequent exact-snapshot
request timeout before the first planned shutdown. The server's protected
error is `TimeoutError: The operation was aborted due to timeout`.
Cleanup completes with Engine exit zero. The driver cannot deliver its
subsequent stop request because the server has already shut down.
No planned cycle runs, and no post-timeout data-integrity claim follows.
The existing request deadline is unchanged.

[The first release setup](release-inherited-fence-setup.json) finds the
observation object still fenced before its initial snapshot. No planned stop
runs. Its cleanup again exits normally. The fence state, rather than release
performance, explains this second setup failure.

The snapshot server requested its fence before entering the cleanup region.
A request that committed and then timed out therefore skipped restoration.
`observation-snapshot.test.mjs` reproduces that case with a controlled request
boundary. It fails before the fix and passes after the fence request moves
inside cleanup ownership. A second regression verifies that cleanup failure
does not hide export failure. Existing fences remain untouched.

All eleven focused Linux tests pass without skips, including process
cancellation, storage isolation, CPU parsing, acceptance analysis, and snapshot
cleanup. These tests establish the tooling repair, not Engine recovery.
Request deadlines, snapshot equality, and campaign thresholds remain unchanged.

## Release diagnostic result

[The release diagnostic](release-diagnostic.json) records the explicit recovery
of this investigation's observation fence from `fenced` to `open` on the copy.
Its initial complete snapshot succeeds. All three planned TERM requests then
exit zero. Both intervening reopens preserve the complete observation and
Installation manifests. The driver captures no snapshot after the third stop.
No tenth-cycle trigger is reproduced and no Engine repair is claimed.

The initial complete snapshot equals the original recovery cohort's saved
baseline, including every Installation table and all 219,939 canonical events.
The event-table SHA-256 remains
`0114eb033b8d570bfdd7ee28fd3509b532b522559721652ef62924d639273996`.
This establishes exact readback from the copied post-failure depot with the
diagnostic release binary. It does not establish a successful tenth shutdown
or reopen the preserved original depot.

The container `stats-stuf90-diagnostic-20261117` is stopped. The failed original
depot remains unopened. Production selection and services are unchanged by
this investigation. The changed disk capacities, diagnostic logging, and
three-stop scope exclude recovery acceptance and timing comparisons.

## Reproduction boundary

Build the recorded Engine revision with the diagnostic patch in the builder
documented by Stuff's `deploy/openorange/patches/README.md`.
Use a private production-image container and a complete copy of the stopped
fixture. Rewrite both Engine storage paths and copied descriptor paths before
opening it. Pass the diagnostic binary SHA-256 to
`bench/observation-overhead-server.mjs`.

Use the protected fixture credential through an HTTP header. Start the
disabled variant through `/start?variant=disabled&round=0`, then capture
`/snapshot`. Only after that succeeds, wait 60 seconds and request
`/engine/stop`. Retain its complete status. Stop after a nonzero exit.
For a zero exit, reopen through `/engine/start` and compare `/snapshot` with
the complete initial snapshot before another diagnostic stop. Limit this
diagnosis to three planned stops. Finish through `/stop` and retain logs and
receipts. This procedure does not authorize an acceptance cohort.
