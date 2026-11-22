# Leased Engine capture on the standby (2026-11-22)

Simplification campaign S1 case 6 and the first-checkpoint "valid
representative Engine capture". The capture ran through
`deploy/orange/recovery/capture-standby.sh` (Stats `e775b8de248`) under the
shared rollout lease. It **failed safely**: no capture was published, every
service was restored and the app passed the functional check. It also
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

## Not established

No valid capture exists yet. Running the stopped-copy capture costs a planned
writer outage of the copy time plus app readiness (113 s here, 2.7 s and
about 50 s in earlier samples); host agents buffer about four minutes.
