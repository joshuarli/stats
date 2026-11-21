# OpenOrange runtime hardening audit

This reference records verified behavior and remaining gaps from the
2026-11-14 production audit. Production application changes are authorized.
S3 backup work remains deferred as P1 in shared-infrastructure ticket STUF-75.

## Installed closure

| Component | Verified artifact |
| --- | --- |
| Stats | `stats:1ea3e6af2dc3`, Orange node version 20 |
| OpenOrange | `open-orange` 1.0.2 |
| RivetKit | 3.1.2-rc.1 |
| Native services package | `@rivet-dev/services` 0.2.5 (removed from the closure on 2026-11-20; see [dependencies](dependencies.md)) |
| Engine OCI index | `sha256:6e585002b700dd4d3630808eb67884aa15d1a602d83781984edac47023b6d40f` |
| Engine AMD64 manifest | `sha256:66de9f77cde47be3cd7af2c001e8083784f6b91ca58b0ab5d7878677cff5bd5d` |
| Native version self-report | 3.1.1, expected for this package and image closure |
| Runtime | Two Workers, `stats` and `stats-observe`, in one Orange deployment |
| Durable persistence | Engine filesystem objects and local log directory |
| Application buckets | Separate VersityGW store. It does not hold Engine durability |

The installed runner SHA-256 is
`ead3f172f836f3339d8c44ca9f50e1f3aa5f13c80781b123236f0b481c760518`.
The Orange lockfile SHA-256 is
`13eafaa9b99d47e67fc1bc1df5c249c9d174756165d93118a62e37f24159104a`.
Readonly live inspection verifies versions, image references and mounts.

The upstream release inventory has no stable release newer than this closure.
OpenOrange 1.0.2 is current. Rivet 3.1.1 is stable, while 3.1.2-rc.1 is newer.
Downgrading the Engine underneath the pinned SDK to obtain a stable label is
rejected. No Engine, SDK or storage upgrade was performed.
See the [OpenOrange release](https://github.com/rivet-dev/open-orange/releases/tag/v1.0.2)
and [Rivet release](https://github.com/rivet-dev/rivet/releases/tag/v3.1.2-rc.1).

## Ranked decisions

REQUIRED addresses a demonstrated defect or a necessary release safeguard.
BENEFICIAL has measured value or a bounded operational payoff.
EXPERIMENTAL needs stronger compatibility or workload evidence.
REJECTED is excluded from this rollout.

| Rank | Classification | Decision | Status and evidence |
| --- | --- | --- | --- |
| 1 | REQUIRED | Stop live ticks cancelling slow range reads | Deployed. Held-response browser regressions fail before the memoization fix and pass afterward |
| 2 | REQUIRED | Persist paired summary timings | Deployed. Same-response headers and stored HTTP events distinguish aggregate reads from actor-call waits |
| 3 | BENEFICIAL | Reuse completed range summaries | Deployed. Five bounded entries, manual and periodic invalidation. Fifteen live switches add no summary requests |
| 4 | BENEFICIAL | Batch Stats self-observation | Deployed. Five native comparisons: median request burst plus summary 146.87 ms to 58.05 ms, with identical data |
| 5 | REQUIRED | Verify the backup writer fence | Shared scripts deployed. A failed stop, discovery error or running writer prevents a backup. Native applications and the bridge recover afterward |
| 6 | REQUIRED | Exercise actual runtime in the release gate | Implemented. `make orange-test` is part of `make check`. All five native cases pass |
| 7 | BENEFICIAL | Add disposable Orange development | Implemented. `make orange-dev` uses the production descriptor generator and removes its runtime and state on SIGTERM |
| 8 | REQUIRED | Establish recurring off-host recovery guarantees | Deferred by owner as STUF-75 P1. No backup SLO or measured full-host RTO is claimed |
| 9 | BENEFICIAL | Reproduce Engine S3 startup failure | Isolated exact-image test: HTTP default times out. `AWS_ALLOW_HTTP=true` becomes healthy. Production remains filesystem-backed |
| 10 | EXPERIMENTAL | Tune native SQLite caches | No setting changed. Native profiling identifies storage waits; raising the staging TTL produces no useful measured gain |
| 11 | EXPERIMENTAL | Expand native runtime gauges | First-Worker metrics omit ObservationStore. Whole-application coverage remains unproven |
| 12 | EXPERIMENTAL | Add independent Engine and runner nodes | Architecture proposal only. Requires independent log storage, failure rehearsals and scoped credentials |
| 13 | REJECTED | Ship the compact JSON expression index | Native SQLite still seeks the canonical table. No established cold-read benefit; removed before deployment |
| 14 | REJECTED | Switch live Engine persistence to VersityGW | Startup compatibility alone does not establish durability, recovery or migration safety |
| 15 | REJECTED | Introduce a general trace backend or orchestration stack | No demonstrated need. Existing producer and private bridge provide the scoped measurements |
| 16 | BENEFICIAL | Cover summary reads with the payload-containing index | Deployed. Five native interleaved rounds remove canonical seeks and reduce first-1h SQL from median 2,465 ms to 123 ms. One following 24h sequence regresses; per-range browser acceptance remains separate |

Measurements, workload boundaries and rejected-index evidence are in the
[range-refresh record](../bench/results/2026-11-14-range-refresh/README.md).
The later native profile, genuine covering index, write costs and compatibility
proofs are in the [index record](../bench/results/2026-11-15-covering-index/README.md).
Current browser and scale acceptance belongs to the
[performance campaign](CAMPAIGN-STATS-PERFORMANCE.md).
The local batching result is not a claim that Lisa's page loads improve by
the same ratio. Live delivery verifies one producer, shared batching and zero
reported drops for the test burst and concurrent page request.

## Runtime compatibility inventory

| Contract | Verified behavior | Gap or boundary |
| --- | --- | --- |
| Actor identity and isolation | Installation and ObservationStore use distinct real actor keys. Platform events have a separate ObservationStore identity | The private bridge filters exact production selectors. Other namespaces are excluded |
| Creation and cold start | Fresh disposable namespaces create actors and accept canonical host data | No proactive recovery or high availability claim |
| Restart and wake | Runtime restart preserves exact history bytes, host identity and replay acknowledgments | Idle eviction and forced-loss in-flight behavior need dedicated native tests |
| Scheduling and alarms | Application alarm logic remains covered by existing adapter and core suites | Native alarm recovery across downtime is not established by the five-case release suite |
| SQLite concurrency | Simultaneous identical STB2 frames jointly accept each sample once. Replays report duplicates and conflicts remain rejected | Broad contention limits and failure under sustained concurrency remain unmeasured |
| Export and restore | Native logical backup restores canonical host and observation state into a fresh namespace | Capture must be disabled in the target descriptor until import completes |
| Cross-Worker requests | Real service-binding ingestion, queries and diagnostic failures pass | This proves the selected fetch path, not every Cloudflare RPC feature |
| Release transitions | Shared image selection uses compare-and-set and monotonic node versions. Failed health checks retain the prior image | Single application instance. In-flight actor drain and multi-node rollout parity remain unproven |
| OpenTelemetry | Native actor invocation and SQLite spans reach the private bridge. Trace IDs and release pins survive translation | Logical method names, separate outbound RPC spans and complete exporter loss accounting are unavailable in the verified path |
| Prometheus | Upstream documents a first-Worker-only listener in multi-Worker deployments | Installation coverage cannot stand in for ObservationStore coverage |
| Security | Forged or absent gateway identity fails. Valid tagged identity passes. Platform ingest uses its dedicated verifier without an Installation lookup | Engine admin credentials remain server-side. A narrower Engine token has not been validated |
| Provider parity | Miniflare remains the fast compatibility and fixture runtime. Orange descriptors omit Analytics SQL and provider tails | Provider CPU, billing and unsupported APIs remain absent rather than becoming zeros |

The native tests are `deploy/orange/{pilot,backup,diagnostics,platform,dev,lifecycle}.test.mts`.
The current observation suite passes 210 cases, and the producer/buffering suites
pass 23. The isolated lifecycle fixture also verifies constructor replacement
after idle, autonomous overdue alarms and idempotent interrupted-request replay.
These counts describe targeted verification, not a complete release
gate for unrelated Rust or frontend changes.

## Applicable upstream reports

| Report | Installed-source evidence | Decision |
| --- | --- | --- |
| [5991: request sleep rearming](https://github.com/rivet-dev/rivet/issues/5991) | The pinned HTTP path still starts a `wait_until` task that waits for idle after each request | Applicable implementation shape. A Stats resource regression under sustained load remains unproven. Keep as a native stress-test candidate |
| [5993: crash-policy behavior](https://github.com/rivet-dev/rivet/issues/5993) | The report demonstrates request-driven wake and an unsupported proactive restart policy on 3.1.1 | Do not infer proactive recovery from normal restart tests. Pinned gateway behavior requires a separate probe |
| [5994: S3-only recovery](https://github.com/rivet-dev/rivet/issues/5994) | Losing the Engine log disk is a separate failure from retaining the object bucket | Preserve logs and object state as one recovery unit. A bucket is not a full backup |
| [5996: actor readiness](https://github.com/rivet-dev/rivet/issues/5996) | Real production actors and fresh native suites become ready on the installed closure | Keep the readiness guard. Do not assume a report against 3.1.1 breaks this installation |

The inspected HTTP implementation is
[pinned Rivet source](https://github.com/rivet-dev/rivet/blob/e5ed3911ebff8ddc35c08b3f6c6eb3f795d042f9/rivetkit-rust/packages/rivetkit-core/src/registry/http.rs).
OpenOrange's open terminal-cleanup PR 34 is a test candidate, not an installed fix.

## Recovery baseline

The protected Mac snapshot `lisa/post-native-observability` has fence timestamp
`20261114T214525Z`, 76,609 files and 9,555,488,768 bytes. Its recorded 169.5 seconds
is fenced backup downtime. It is not restore RTO.

The older `20261114T184204Z` physical snapshot has an independent Engine and
Store restore rehearsal with full object checksums and an application HTTP
probe. That probe does not prove the newest Stats state. The native logical
suite independently checks Stats state and restored ingestion behavior.

No recurring backup scheduler was found in the shared installer source.
The age warning is weaker than a verified off-host freshness SLO. RPO is bounded
only by writes after the latest independently verified off-host fence.
Full-host replacement RTO is unmeasured. Lisa and its local disk remain one
failure domain.

Three Engine nodes with independent log disks and external object storage could
reduce host-failure exposure. Independent runners could reduce application-node
downtime. That design adds hosts, network dependence, storage cost and rollout
complexity. Same-host replicas do not solve the disk failure model. No migration
is justified before isolated failure tests and a complete recovery receipt.

## Primary operational references

- [Orange production checklist](https://openorange.dev/docs/operations/production-checklist/)
- [Orange monitoring and its Worker coverage limit](https://openorange.dev/docs/operations/monitoring/)
- [Orange Durable Object implementation](https://openorange.dev/docs/internals/durable-objects/)
- [Orange compatibility](https://openorange.dev/docs/compatibility/)
- [Rivet self-hosted storage](https://rivet.dev/docs/deploy/self-host/control-plane/storage/)
- [Rivet backups](https://rivet.dev/docs/deploy/self-host/control-plane/backups/)
- [Rivet upgrades](https://rivet.dev/docs/deploy/self-host/control-plane/upgrades/)
- [Rivet node production checklist](https://rivet.dev/docs/deploy/self-host/nodes/production-checklist/)
- [Native performance measurements](https://rivet.dev/actors/docs/performance-monitoring/)
- [SQLite profiling](https://rivet.dev/actors/docs/sqlite-profiling/)

Use [runtime observations](platform-observability.md) for the telemetry
contract and its explicit coverage gaps.

## Validate or roll back the hardening release

Run these commands from the Stats checkout with its pinned Node and pnpm.
The deployed application is `stats:6cc06db247a3`, Orange node version 24.
The compatible rollback image is `stats:03d3d4f1fcb8`, node version 23.

### Verify the deployed application

1. Read the selected image and shared health:

   ```sh
   ssh josh@lisa 'doas -n /opt/openorange/bin/oo deployment stats'
   ssh josh@lisa 'doas -n /opt/openorange/bin/health --json'
   ```

2. Open `https://stats.17166969.xyz/#/project/stats` from an authorized tailnet client.
3. Load 1h, 6h and 24h, allowing each initial request to finish.
4. Switch among those completed windows. Confirm charts update without another summary request.
5. Click Refresh. Confirm a fresh summary request completes.
6. Inspect that response's `Server-Timing` fields. Compare `app-dispatch`, `app-store`, `app-query` and `app-read` from the same response. They overlap; do not add them.
7. Open Requests and inspect the corresponding `http.get.application-summary` event. Confirm integer microsecond work fields are present.
8. Inspect delivery metadata after a request burst. Allow roughly one second before expecting newly captured HTTP events. Browser transport's HTTP 202 means admission, not durable ingestion.

The latest paced verification observes all 200 browser journeys becoming
queryable within 1.52 seconds, with no browser or producer drops. A separate
burst stores 908 of 1,005 journeys and reports the other 97 as browser transport
drops; producer drops are zero. These checks do not establish lossless delivery
under an outage or sustained overload. See the
[delivery evidence](../bench/results/2026-11-15-producer-boundaries/README.md).

### Repeat targeted verification locally

Use disposable state under `.work/tmp`:

```sh
make orange-test
pnpm --dir cloudflare test:observe
node --test cloudflare/test/producer/producer.test.ts \
  cloudflare/test/observe/application-buffered.test.ts
pnpm --dir cloudflare exec playwright test test/ui/range-refresh.spec.ts \
  test/ui/platform.spec.ts
```

Run `make check` for the complete release gate. The commands above are the
targeted checks for this release. `make orange-dev` starts an isolated Orange
development session. `make dev` retains Miniflare.

### Deploy another verified application revision

Commit and push the verified application changes, then run:

```sh
sh deploy/orange/deploy.sh josh@lisa
```

The script builds an AMD64 image, verifies its descriptors and readable assets,
selects it conditionally, restarts Stats and checks production behavior.
It restores the prior image if deployment health fails. It does not upgrade
the Engine or change its persistence.

### Roll back this application release

Confirm no later operator has selected another image before running:

```sh
ssh josh@lisa 'doas -n /opt/openorange/bin/oo set-image stats stats:03d3d4f1fcb8 --if-current stats:6cc06db247a3'
ssh josh@lisa 'doas -n /sbin/rc-service oo-app.stats restart'
ssh josh@lisa 'doas -n /opt/openorange/bin/oo wait app stats 120'
ssh josh@lisa 'doas -n /opt/openorange/bin/health --json'
```

Stop if conditional selection fails. Inspect the concurrent deployment instead
of overriding it. Verify HTTPS and the dashboard after the health check.
There is no canonical-data migration to reverse. This rollback retains stored
events, both derived tables and their mutation triggers while selecting the
compact-projection query. The rollback reader excludes both derived tables
from logical snapshots. Do not drop derived tables, triggers or the old payload
index during rollback. Earlier readers do not exclude rollups from snapshots
and are unsuitable rollback targets after rollup creation.
The protected pre-projection logical backup contains 16 tables and 228,029 rows,
including 52,393 canonical events. Read and write comparisons, exact native
restore checks and the unresolved private Engine reopening failure are recorded
with the [projection evidence](../bench/results/2026-11-15-compact-projection/README.md).

### Resume deferred infrastructure work

Resume STUF-75 when S3 backups return to scope. Preserve Engine logs and object
state in the same fenced recovery artifact. Rehearse a restore before relying
on the destination. Record the independent off-host fence and elapsed restore
stages separately from backup downtime.

Before a storage or Engine migration, prepare verified backups, an isolated
successful rehearsal, consistency checks and an executable rollback path.
Current application deployment authorization does not supply those proofs.
The audit above identifies remaining native parity
and instrumentation gaps.
