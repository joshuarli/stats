# Simplification S0 baseline, partial (2026-11-22)

What was inspected or measured on 2026-11-21/22 for the supported Stats
writer. Everything not listed under "Measured" is still open for S0. Live
state changes; refresh identities before any mutation.

## Topology and identity (read-only inspection, 2026-11-22 00:30 UTC)

| Fact | Value |
| --- | --- |
| Writer authority | Lisa `/etc/openorange/recovery-routes.json`: `stats.mode` `writer`, upstream `127.0.0.1:18489` (no generation field) |
| Guest | Threadripper VM `stats-recovery-vm`, Alpine 3.24.4, kernel 6.18.60-virt, 8 vCPU, 3.9 GiB visible RAM, clocksource `kvm-clock`, 26 GiB root at 75–83% used |
| VM reservation | `cpu.weight 10000`, `memory.min 5G`, `memory.swap.max 0`, `io.latency` 10 ms (`deploy/orange/recovery/stats-recovery-vm.openrc`) |
| App | `app-5091917968f7` (`stats-30a64ac4fac6`), selected by `/opt/native-rehearsal/app/current`; previous `app-b2240ba9ef21` |
| Runtime | `rt-2c70c316ce8d` (`open-orange 1.0.2-laputa.2`), previous runtimes `rt-13b896622da5`, `rt-3abd20d29960`, `rt-a26798107529` kept |
| Engine | `live-stats-engine`, `rivetdev/engine@sha256:6e585002…`, 4 CPUs, 3 GiB memory, 6 GiB memory+swap, host network, listeners 6420 and 6430, namespace `stats-prod`; matches Stuff `deploy/openorange/standby/stats-engine.json` |
| Depot | `/var/lib/live-stats` (`log`, `objects`), 3.7 GiB |
| Services | OpenRC `docker`, `native-stats` (supervise-daemon, `TERM/30/KILL/5`), `stats-infra-collector` (needs `native-stats`) |
| Ownership gaps | Guest packages, users, `native-stats`/`native-engine`/`native-store` units and `conf.d` secrets are hand-made and untracked |

## Measured

| Step | Result | Source |
| --- | --- | --- |
| App release build, Worker bundles already built | 7 s | `app-release.mts`, 2026-11-22 |
| `make cloudflare-test` (admission check) | 112 s | 2026-11-21 23:50 |
| Standby app transaction, lease to activated | 9 s (no conversion); 16 s including first conversion | rollout journals `f4af49d7`, `2bbbf753` |
| Restart to functional readiness (synthetic ingest with readback) | 2.7 s, about 3 s, about 50 s, 113 s | deploy `f4af49d7`, recovery in `2bbbf753`, measured restart at 00:14, after the capture at 01:37 |
| `/health` lead over readiness | 42 s in the measured restart | 00:14 restart |
| Runtime archive transfer to Threadripper (687 MB, tar over ssh) | 245 s | 2026-11-22 |
| Depot read while serving | 3.7 GiB in about 92 s, and the app lost its Engine registration during it | capture record |
| Two-build smoke qualification on Threadripper | completed and passed | two-build record |

The readiness samples range from 2.7 s to 113 s; four samples are not a
distribution and are not a budget. The 113 s sample followed an Engine
restart; the others followed app restarts only.

## Measured on 2026-11-22 (second pass)

Repeated timings, from a fresh worktree of Stats `d085e516cb4` on the
workstation (`.work/tmp/s0/timings.sh`):

| Step | Runs (s) | Note |
| --- | --- | --- |
| Dependency preparation, new worktree | 0.7 | 113 packages linked from the warm pnpm store; no download |
| Dependency preparation, warm | 0.1, 0.1, 0.1 | |
| App release build (`app-release.mts`) | 5.6, 2.1, 2.3 | first run cold for the Worker build cache |
| `make cloudflare-test` at `d085e516cb4` | 210.6, 188.0, 206.2 | **failed every run** (below) |
| `make cloudflare-test` at `9696114d902`, fresh worktree | 128, 118, 118 | 1,040 tests, 0 failures |
| Runtime build (`build-runtime-artifact`, `runtime-candidate-laputa.2.json`, Docker on the workstation) | 31, 25, 25 | every build reproduced production's manifest digest `sha256:2c70c316…`; the two warm builds produced the same archive `sha256:ce1e7c93…`, which differs from production's older `sha256:6cb79216…` |

`make cloudflare-test` was red at the baseline commit:

- `recovery-capture.test.ts` still called the pre-lease capture interface;
  fixed in `d92ecf87a83`.
- `development.test.ts` failed in a fresh worktree (`orange dev` exited with
  `MODULE_NOT_FOUND`): it runs the OpenOrange closure from
  `deploy/orange/node_modules`, which only `make orange-ready` installs, and
  `cloudflare-test` did not depend on it. Fixed in `9696114d902`.

Idle production resources (2026-11-22 14:40 UTC, `bench/standby-soak.py`
probe): app 3 processes, 824 MB RSS; collector 72 MB; Engine 2.0 GB of its
3 GiB limit, CPU in bursts between 1% and 140% of one core with no warnings;
guest free disk 5.6 GB; log shards 135 MB, cold cache 896 MB of a 936 MB
auto-sized budget, objects 1.6 GB. The cache had evicted 65 GB since its
02:36 start. Representative-load resources come from the sustained soak.

Readiness samples added on 2026-11-22: a disposable recreation provisioned in
2 m 16 s with its first functional check 7 s later
([guest recreation](../2026-11-22-guest-recreation/README.md)); production's
app restart at 15:59:50 was functional 11 s later, and its Engine
configuration apply at 16:00 completed in 18 s with the functional check 12 s
after the restart ([Engine degradation](../2026-11-22-engine-degradation/README.md)).
Staging is the 245 s runtime transfer above; app rollback is the 3 s recovery
in the [standby app transaction](../2026-11-22-standby-app-transaction/README.md).
Neither was repeated: staging and rollback change production, which the soak
holds fixed.

## Frozen recovery budgets

Fixed on 2026-11-22 before recovery qualification, for the Threadripper
standby writer. Stricter existing limits still apply.

| Budget | Limit | Measured so far |
| --- | --- | --- |
| Detection: an observer alert opens | 5 min | 35 s (`hosts`) and 2 m 23 s (`ingest`) for the 01:45 relapse; delivery stays deferred, which is why that relapse went unnoticed for 37 minutes |
| Recovery to safe writes after a restart or after pressure ends | 120 s to a passing functional check | 2.7–113 s readiness samples |
| Backup data age (RPO) | 24 h, verified off-host | `sim-20261122T0236Z`, verified off-host 2026-11-22 |
| Restore time: sealed off-host capture to a functional check on a fresh guest | 30 min | about 17 min: 14 m 39 s capture upload at 2.6 MB/s, 2 m 23 s provisioning and check |

## Preserved state and allowances

- Protected captures: `threadripper-20261118T035957Z` (off-host, and on the
  guest's disk) and `sim-20261122T0236Z` (off-host, verified; on the guest's
  disk). The partial `sim-20261122T0135Z` was deleted on 2026-11-22.
- The tenfold fixture and the STA-128 and P8 allowances are unchanged; see
  the [resumption record](../../../docs/roadmap.md#campaign-performance).
- New diagnostic profiles of this campaign and their own runs are recorded with
  STA-135 ([Engine degradation drills](../2026-11-22-engine-degradation/README.md)).

## Limits of this baseline

- Backend edit-to-ready in `make dev` is not timed; S4 owns that loop and
  measures it before changing it.
- Staging and rollback have one sample each, for the reason above.
