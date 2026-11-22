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

## Open for S0

- Clean and warm timings for dependency preparation, Worker builds, focused
  tests, runtime build and staging, each repeated as the campaign prescribes.
- Idle and representative-load CPU, memory, disk growth, latency and verified
  work counts; observation-overhead status stays as STA-128 records it.
- Frozen detection, recovery-to-safe-writes, backup data-age and restore-time
  budgets. No current verified capture exists (the 2026-11-22 capture failed
  safely); the last protected copy is `threadripper-20261118T035957Z`.
- Preserved failed depots and attempt allowances inventory.

Records: [standby app transaction](../2026-11-22-standby-app-transaction/README.md),
[Engine capture](../2026-11-22-engine-capture/README.md),
[two-build qualification](../2026-11-22-two-build-qualification/README.md).
