# Standby Engine degradation: reproduction and repair (2026-11-22)

Simplification campaign S2 and STA-135. **Reproduced** on a validated copy of
production state, **repaired** with a declared Engine configuration that
survived the same condition in three of three cycles, and **applied to
production** at 16:00 UTC under the rollout lease. The 400% CPU spin seen in
two production episodes was not reproduced and remains unattributed.

## Mechanism

With `storage.log_shard.max_disk_bytes` and `storage.cold_store.disk_cache_bytes`
unset, the Engine sizes its log shard and cold cache once, at startup, from its
filesystem: free space plus what its own directories hold, minus a reserve of
10% or 4 GiB, split 50/50 (Rivet `engine/packages/depot-worker/src/disk_budget.rs`).
The standby guest's 26 GiB root also holds old runtimes and on-disk captures,
so each restart sizes the log from whatever free space it happens to see. When
the budget falls to within about 2% of what the shard already holds, every
write command misses its deadline: the Engine logs `loading the migration
state failed … request_deadline_exceeded`, the app logs `RivetKit registry did
not register with the Engine within 30000ms` and never becomes ready, and
Engine CPU stays near 1%.

Production's own starts fit it:

| Engine start (UTC) | Free-space condition | Resolved log budget | What followed |
| --- | --- | --- | --- |
| 2026-11-22 01:37:18 | 3.6 GiB partial capture copy on the disk | 289 MB | STA-135 loop from 01:45 for 37 min |
| 01:46:10 | same | 257 MB | `log shard disk is near its capacity` |
| 02:36:54 | partial deleted | 936 MB | healthy for 13 h |

## Drill

A disposable guest recreated from the tracked definition and the validated
capture `sim-20261122T0236Z` (run `s1c7-20261122k`, see the
[guest recreation](../2026-11-22-guest-recreation/README.md)) ran on
Threadripper with its disk on tmpfs, so no drill wrote to production's disk.
`deploy/orange/recovery/engine-pressure-drill.sh` drives one cycle: optional
ballast so a set number of bytes stays free followed by an Engine and app
restart (the free-space condition), load from `contention-load.mts` (6 hosts,
14 services, 20 events per service every 5 s, a host frame every 10 s, one
dashboard read per round), a fault for the pressure phase, then release, a
120 s recovery deadline and a relapse watch. Samples every 5–7 s record Engine
CPU, warning classes, free disk and a synthetic ingest with readback and
duplicate replay every 30 s. Healthy means no refused connect or deadline
warning and Engine CPU under 100% in two consecutive samples, plus a passing
check after release.

| Run | Condition | Resolved log budget | Result |
| --- | --- | --- | --- |
| `r0-harness` | no fault | 7.0 GB | harness defect: checks ran in a subshell and hit the check host's rate limit; fixed |
| `a1-budget` | 4.75 GB free | 339 MB | invalid: the load driver started during the app restart and exited; fixed (load liveness guard) |
| `a2-budget` | 4.75 GB free, 15 min load | 463 MB | pass; no warnings |
| `a3-shrink` | 4.0 GB free | **136 MB for 134 MB resident** | **failure reproduced**: 7 migration-state deadlines in 70 s, app never ready, `did not register` |
| `c1-fixed` | 4.0 GB free, declared 1 GiB / 512 MiB, 10 min load | 1 GiB (configured) | pass; recovered 14.7 s after release |
| `c2-fixed` | same | 1 GiB | pass; 8.4 s |
| `c3-fixed` | same | 1 GiB | pass; 8.1 s |
| `n1-auto` | negative control, 4.0 GB free, auto-sized | 179 MB (75% resident) | pass; wrote to cold early (`near its capacity`) but served |
| `n2-auto` | negative control, 4.257 GB free, auto-sized | **137 MB for 135 MB resident** | **failure reproduced again**: 18 migration-state deadlines, app never ready in 180 s, 11 `did not register` |
| `r1-repaired` | the failed `n2` state, declared config applied | 1 GiB | app ready 6 s after the Engine started; ingest, readback and replay pass |
| `b2-stall` | declared config, QEMU throttle 20 IOPS and 1 MB/s for 120 s under load | 1 GiB | pass; 17 alarm-callback retries during pressure, no refusal or deadline, checks pass |
| `b1-warmread` | declared config, read-only depot read loop throttled to 300 IOPS and 40 MB/s for 300 s under load | 1 GiB | pass; no Engine warning at all, recovered 8.1 s after release |

Each candidate cycle served 2,436–2,450 event batches, 516–522 host frames and
174–175 reads, all accepted, and 27 of 27 synthetic checks passed. `n1` shows
the failure depends on the budget relative to the shard's resident size, not on
free space alone; the negative control was rerun at the production ratio.

Cycle 2's log also shows the restart transients of each cycle's planned Engine
restart (one refused connect and a fenced maintainer within 12 s) and, about
5 s after its release, ten `volume alarm callback failed … overloaded`
retries and one `filesystem opening failed QuorumUnavailable` with the replica
log read window at its cap of 4 (`max_background_cold_reads`). They cleared
without a failed check. The same bursts followed production's 02:22 recovery.
They are the next lever in Stuff's ranked list, not this failure.

## Repair

Stuff `b9cd9232` declares `storage.log_shard.max_disk_bytes` 1 GiB (about
8× the resident shard) and `storage.cold_store.disk_cache_bytes` 512 MiB in
`deploy/openorange/standby/stats-engine.json`; the object store is the same
local disk, so a smaller cache costs little. A configured capacity that does
not fit free space plus the Engine's own files fails startup instead of
shrinking, so a full disk becomes a visible start failure.

`deploy/orange/recovery/apply-engine-config.sh` applied it to production
(`sta135-capacities-20261122b`, 16:00:09–16:00:27 UTC): the Engine resolved
the declared capacities, the functional check passed 12 s after the restart and
`standby-engine inspect` reported no drift. Receipt:
`~/.local/state/openorange/engine-config/sta135-capacities-20261122b.json`.
Production's resolved log budget went from an auto-sized 936 MB to a fixed
1 GiB, and its cache from 936 MB to 512 MiB.

The first attempt (`sta135-capacities-20261122`, 15:58) was refused before
changing anything: the 02:36 capture had started `native-stats` and its
collector with the capture lock's descriptor open, their `supervise-daemon`s
inherited it, and every later capture or configuration change would have been
refused as already owned. Fixed in Stats `02773ac82cd`; production's daemons
were restarted under the lease at 15:59:50 to release it (functional again at
16:00:01).

Captures now refuse before stopping anything when the copy would leave less
than 2 GiB free (Stats `9bcf8a0ff7f`), since a capture copies the depot onto
the Engine's filesystem.

## Not established

- The 400% CPU spin of the 2026-11-21 22:40 loop and of the 01:45 relapse.
  Every reproduced failure here was a deadline stall near 1% CPU. The 22:40
  loop's startup budget was not preserved, so whether it began the same way is
  unknown. The sustained soak watches for it with the declared configuration
  in place.
- The original 01:35 trigger wrote a 3.6 GiB copy to the depot's own disk; the
  drill's warm read is read-only because the disposable guest's overlay lives
  in Threadripper's RAM. `DRILL_COPY=1` runs the copying variant where space
  allows.

## Evidence and reproduction

Raw runs: `~/.local/state/openorange/sta135-drills/2026-11-22/` on the
workstation (`evidence.sha256` lists every file). The guest was
`s1c7-20261122k`.

```sh
GUEST_HOST=threadripper GUEST_ROOT=/tmp/stats-guest STATS_CHECK_CREDENTIAL_FILE=~/.config/stats/synthetic-check.json \
STATSCTL=~/.local/state/openorange/rollout/tools/statsctl DRILL_FREE_BYTES=4257000000 \
BASELINE_S=60 PRESSURE_S=300 RECOVERY_S=120 WATCH_S=60 \
  deploy/orange/recovery/engine-pressure-drill.sh GUEST none OUT_DIR
```

Choose `DRILL_FREE_BYTES` so the auto-sized log budget is within 2% of the
guest's resident `log/shards` size: budget = (free + `du -sb log`) − max(10% of
the filesystem, 4 GiB), halved.
