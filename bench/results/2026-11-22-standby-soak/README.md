# Sustained-operation soak of the Threadripper standby writer

Simplification campaign S6's operational soak, run on the selected deployment:
the native Stats standby writer on Threadripper (`stats-standby`), serving
production through ordinary ingress. Lisa is not the target.

## Definition (frozen before the start)

`definition.json` in this directory is the machine-readable definition. The
sampler binds its SHA-256 into its start record, and
`bench/analyze-standby-soak.py` judges the run against it. Changing it after
the start creates a new soak, not a reinterpretation of this one.

**Deployment under test.** App `app-5091917968f7`, runtime `rt-2c70c316ce8d`,
Engine `rivetdev/engine@sha256:6e585002…` with the configuration declared in
Stuff `b9cd9232` (log shard 1 GiB, cold cache 512 MiB), applied at
2026-11-22 16:00 UTC. The sampler records the loaded identities every minute;
any change outside a restarting fault fails the run.

**Traffic.** Production's own traffic (five reporting hosts, the platform
bridge, the collector and dashboard readers) plus one synthetic ingest with
readback and duplicate replay every five minutes through ordinary public
ingress, from a dedicated `soak-check` host (`h_2563bec7…`) so the ledger
contains only soak writes and the check never shares the observer's admission
budget. No synthetic load generator runs: the soak qualifies the deployment
under the traffic it actually serves.

**Collection.** `bench/standby-soak.py` on Threadripper's host, outside the
guest: 1,441 samples, one a minute. Each holds the loaded identities and
process start times, app and collector RSS and CPU, Engine memory and CPU,
guest free disk, log shard and cache bytes, selected Engine gauges, Engine
warning classes since the previous sample, actor counts and application
health. Every hour it freezes the metric store's source coverage for the hour
that closed two minutes earlier, before the store's 24-hour retention can drop
it. Records are fsynced JSON lines on the host's disk.

**Faults** (`bench/standby-soak-faults.py`, offsets from the sampler's start).
Each guest fault runs under the shared rollout lease; host faults run in their
own cgroups, never in the production VM's. After each, synthetic checks 30 s
apart measure recovery, up to 600 s.

| Offset | Fault | What it does |
| --- | --- | --- |
| 3 h | `app-restart` | `rc-service native-stats restart` (the collector follows) |
| 7 h | `engine-restart` | stop the collector and app, restart the Engine, wait for its health, start the app and collector |
| 11 h | `depot-warm-read` | read the whole depot from the disk that holds it, while serving, for up to 300 s; nothing written |
| 15 h | `host-cpu` | 64 busy loops on Threadripper for 600 s at CPU weight 100 |
| 19 h | `host-disk-write` | 4 GiB written to Threadripper's disk at 100 MiB/s, fsynced, then deleted |

The 2026-11-22 drills reproduced the STA-135 failure through a startup-sized
log shard; the Engine restart fault is the condition that used to resize it.
The host disk-write fault is the contention that degraded production on
2026-11-22 04:45 (latency 1.4–1.9 s). The soak reports it, and does not expect
latency to stay flat during it.

**Pass requires all of the following.** Fault windows are each fault's run
plus 120 s; "steady" means outside them. Failures inside fault windows are
reported separately and still count in the inclusive totals.

1. Complete collection: 1,441 samples, none later than one interval, at least
   24 hours, no unavailable probe group in steady operation, an hourly source
   export for every hour.
2. No lost acknowledged write: every synthetic write the sampler or the fault
   runner saw acknowledged is in the host's raw history at the end
   (`bench/standby-soak-ledger.mts`).
3. Steady availability: at least 99% of steady synthetic checks pass.
4. Steady latency of the synthetic check's ingest and latest-read steps:
   p95 ≤ 500 ms and p99 ≤ 1,000 ms, the promotion profile's absolute limits.
5. Each fault recovers to a passing synthetic check within 120 s of its end.
6. No unplanned restart or deployment change: process and Engine identities
   change only inside `app-restart` or `engine-restart`, and the Engine is
   never OOM-killed.
7. No sustained Engine refusal outside fault windows: fewer than three
   consecutive samples with refused connects or deadline warnings.
8. Bounded memory (the P8 rule): the median app RSS and Engine anonymous
   memory (its cgroup's `anon`, which excludes page cache) over the
   final 12 hours are within 5% of the median of hours 6–12.
9. No growing queue over the final 12 hours (tablet store queue, log client
   queue, parked alarms, queued group reads): an hourly-median slope no more
   than 0.5 a hour; actor populations grow less than 2% a hour.
10. Bounded storage: guest free disk never below 2 GiB.
11. Complete source coverage: every hourly export of the soak attributes
    `engine:live`, `worker:stats:0` and `worker:stats-observe:1` to a release
    with each declared family usable. A planned collector restart leaves no
    attributable evidence for the hour that contains it, so an export that
    overlaps `app-restart` or `engine-restart` must instead report each source
    as `ok` or `collector-restart`, and is listed separately.

A missing interval or missing evidence makes the run **inconclusive**, not a
pass. Known coverage gaps, which are not treated as plateaued: runtime inbox
depth, native export-loss counters, actor lifecycle timestamps, and
application producer queues other than through delivered observations. If the
run is invalidated, it is restarted once with a fresh output path; a second
invalidation blocks the soak.

## Starts

- `standby-20261122`, started 2026-11-22 16:34:03 UTC and stopped after two
  samples: its first hourly source export covered the hour before the soak,
  which held the 16:00 configuration apply, and the definition had no rule
  for the hours that contain a planned collector restart, so the run could only
  have ended inconclusive. The sampler now exports from the soak's first hour
  and criterion 11 says how restart hours are judged. This consumed the soak's
  one allowed restart: another invalidation blocks the soak.
- `standby-20261122b` is the soak.

## Result

Pending.
