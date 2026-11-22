# Leased Engine capture on the standby (2026-11-22)

Simplification campaign S1 case 6 and the first-checkpoint "valid
representative Engine capture". The capture ran through
`deploy/orange/recovery/capture-standby.sh` (Stats `e775b8de248`) under the
shared rollout lease. The first run **failed safely**: no capture was
published, every service was restored and the app passed the functional
check. The Engine relapsed into the STA-135 loop eight minutes later. A
stopped-copy capture at 02:36 succeeded and was validated (below). It also
produced STA-135 evidence: a warm copy of the depot made the app lose its
Engine registration while the Engine was running.

## Timeline (UTC)

| Time | Event |
| --- | --- |
| 01:35:20 | Lease `engine-capture` acquired; warm `rsync` of `/var/lib/live-stats` (3.7 GiB) started with the Engine and app running |
| 01:36:18 | App: `sqlite xRead failed without changing storage; the statement fails with a typed storage error` |
| 01:36:32 | App: `stopping all actors after losing the engine connection or registration` (twice) |
| 01:36:54 | Warm copy finished; intent recorded; collector and `native-stats` stopped |
| 01:36:56 | Engine container exited with code 1 on its own; Docker's `unless-stopped` policy restarted it |
| 01:36:57–01:37:17 | `docker stop --time 20`: 20 `stop request failed; retrying while serving` warnings, then SIGKILL (exit 137) |
| 01:37:18 | Capture refused the unclean stop (exit code not 0); its exit trap started the Engine, waited for health, then started `native-stats` and the collector, and removed the intent |
| 01:37:19 onward | `native-stats` needed 3 supervisor respawns before registering; the Engine logged 564 deadline and registration warnings |
| 01:39:15 | Functional check (synthetic ingest with readback) passed 113 s after the restore, inside its 120 s budget. `recover` found no intent left. Receipt outcome `failed` |
| 01:40–01:43 | Engine CPU 1–28%, no warnings, no further respawns; data API 200 in about 65 ms; all five hosts reporting |

Receipt: `~/.local/state/openorange/captures/sim-20261122T0135Z.json` on the
workstation (`captureExit` 1, `recoverExit` 0, `functional.ok` true,
`readyAfterS` 113). The incomplete copy is in
`/var/lib/live-stats-recovery/sim-20261122T0135Z.partial` (3.6 GiB, never
stopped-copied, not usable as a recovery point); the guest has 4.2 GiB free.

## What this establishes

- The leased capture's safety properties held in production: an unclean
  Engine stop was refused, the recorded intent was restored, the failure was
  recorded truthfully and the app was functionally verified afterwards.
- Reading the depot with `rsync` while the Engine runs, on the guest disk that
  holds it, was followed within 58 s by a typed storage read failure and
  within 72 s by registration loss. That is one occurrence, not a
  distribution, and the copy's read rate was not measured. It is the first
  disk-I/O trigger observed for the STA-135 registration failure; CPU
  contention alone did not reproduce it.
- Stopping `native-stats` after the registration loss was followed by the
  Engine exiting with code 1, and the restarted Engine ignored a stop for
  20 s. Whether that exit is a consequence of the storage stall is unknown.

## Change made

`capture-engine.sh` no longer copies the depot while the Engine runs. It
stops the app and Engine, copies once with a 300 s bound (lease 900 s), and
restarts. The stopped duration therefore grows by the full copy time; the
copy time of 3.7 GiB on this disk is unmeasured. This version has not run in
production.


## Relapse after the failed capture (01:45–02:22 UTC)

The Engine looked settled from 01:40 to 01:43, and the check stopped at 01:42:50.
At 01:45:03 it entered the STA-135 loop: about 400% CPU (its 4-CPU cap),
`refusing envoy connect that storage could not register`, `Envoy connection
closed` and roughly 40 warnings a minute, with the data API returning 503.
Nothing alerted; it was found at 02:18 when the leftover partial copy was
deleted (the delete did not start it). Recovery under the lease: stopping
`native-stats` (and its collector) at 02:20:59 dropped Engine CPU to 1% by
02:21:46; starting both at 02:22:04 passed synthetic ingest at 02:22:10.
Outage: about 37 minutes.

For about three minutes afterwards the Engine logged bursts of `volume alarm
callback failed; the unacknowledged alarm will retry`, `depot command failed
with an unstructured error`, flush-slot waits and one `log shard disk is near
its capacity` warning (200 MB of a 257 MB `storage.log_shard.max_disk_bytes`
budget, 75% watermark), then went quiet with CPU bursting between 1% and 120%.

## Stopped-copy capture (02:36 UTC): captured

After three quiet samples (Engine below 20% CPU) and with a watcher alerting on
warning bursts or non-200 responses, `capture-standby.sh sim-20261122T0236Z`
(Stats `cffb0fa98d5`) ran:

| UTC | Event |
| --- | --- |
| 02:36:46 | Lease `engine-capture` acquired |
| 02:36:47 | Collector and `native-stats` stopped, then the Engine (clean stop in 3 s, exit 0) |
| 02:36:50 | Stopped copy started |
| 02:36:55 | Copy done; Engine started and healthy; `native-stats` and collector started |
| 02:37:13 | Functional check passed (8 s after the restore); receipt `captured` |

The writer was unavailable for about 16 seconds. The watcher saw only the
expected 502 at 02:37:01 and no warnings over the following 20 minutes.

- Capture: `/var/lib/live-stats-recovery/sim-20261122T0236Z` on the guest,
  792 files, 2.3 GiB, `depot.sha256` digest
  `sha256:84d48d41d769312ad019586936b79746c6292eee9ac325e50b8cadc975eaba4b`,
  Engine image `rivetdev/engine@sha256:6e585002…`.
- Off-host copy: `~/backups/openorange/stats/standby-sim-20261122T0236Z/`
  on the workstation (owner-only), copied with `rsync --bwlimit=8000` in
  14 m 49 s with no Engine warnings; all 792 files verified against
  `depot.sha256`.
- Validation: the pinned Engine image started on a scratch copy of it
  (linux/amd64, loopback only, a validation-only admin token) and answered
  health within 4 s, read its tablet manifests and started 18 state machines
  with no `ManifestMissing`, corruption or panic. The namespace list was
  intact, and `stats-prod` held the same actors as production:
  `installation-917ceba9` 1, `observation-store-13f29dce` 14,
  `metric-store-e8ed0a9e` 1, none destroyed.

Not yet established: application-level readback of the copy (history and
events through `native-stats` on restored state), which needs a full app
stack on it.
