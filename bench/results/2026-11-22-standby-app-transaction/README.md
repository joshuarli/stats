# Standby app deployment through the rollout transaction (2026-11-22)

Simplification campaign S1. The standby Stats app and collector now deploy
through Stuff's journaled rollout transaction (`--target-kind native-app`,
Stuff `b632aba9`, `d0768035`) instead of `standby-deploy.sh`'s own activation
and unconditional rollback. Stats side: `262ecaa6a56`, `30a64ac4fac`.

## Defect removed

`standby-deploy.sh` read the current app before taking the lease, checked
public health after releasing it, and took a second lease to restore the
previously read app on any failure, including a refused lease. A failed
deployment A could therefore restore its old app after a later deployment B
had activated. This was found in source review; no incident is attributed to
it. The transaction now holds one lease through writer-authority recheck,
activation, verification and recovery. Recovery reactivates the baseline only
while the run's own candidate is selected; otherwise it stops at
`needs-operator`.

Regression tests (Stuff `deploy/openorange/tests/test_rollout_native_app.py`,
run against a simulated guest with the real guest script):

| Campaign S1 case | Test |
| --- | --- |
| 1. Refused lease changes nothing | `test_refused_lease_changes_nothing` |
| 2. A cannot roll back a later B | `test_a_stale_deployment_cannot_roll_back_a_later_one` |
| 3. Authority change prevents activation | `test_writer_authority_change_after_prepare_prevents_activation`, `test_refused_writer_authority_rejects_before_preparation` |
| 4. Changed bytes or runtime refuse; app-only reuses the runtime | `test_changed_runtime_or_app_bytes_are_refused`, `test_app_promotion_reuses_the_runtime_and_survives_each_crash` |
| 5. Controller death gives one completion | `test_app_promotion_reuses_the_runtime_and_survives_each_crash` (8 crash points) |

Cases 2 and 3 were mutation-checked: removing the conditional activation
check or the authority recheck makes them fail. Cases 6 (capture ownership)
and 7 (disposable-guest recreation) remain open.

## First production run: recovered (journal `2bbbf753`)

| UTC | Event |
| --- | --- |
| 00:10:53 | Lease acquired; admission receipt verified; authority recorded |
| 00:10:57 | `convert-app`: in-place app and collector became `app-b2240ba9ef21`, digest unchanged |
| 00:11:09 | Candidate `app-040fd6db8857` (`stats-262ecaa6a562`) activated |
| 00:11:26 | First functional check: identity ok, synthetic ingest failed |
| 00:11:57 | Baseline reactivated under the same lease |
| 00:12:00 | Baseline check passed; `recovered`, lease released |

No app source differed between baseline and candidate. The Engine log showed
stop commands to the previous runner's actors timing out (00:11:12, 00:11:24)
while the new process was already listening.

## Restart-to-functional readiness

A leased `rc-service native-stats restart` of the unchanged baseline at 00:14:10,
probed with `statsctl check ingest` every 2 s from the workstation:

- The restart, including its guest health wait, returned at 00:14:18.
- Ingest failed with HTTP errors until 00:14:17, then timed out at 15 s twice.
- The first passing ingest was at 00:15:00: about 50 s after the restart began
  and 42 s after health returned.

So `/health` does not establish readiness after a restart, and the first run
was a readiness race, not a candidate defect. The controller previously
required the first verification check to pass and made a single baseline
check before `needs-operator`, so recovery could also have stopped on
readiness alone. Stuff `d0768035` adds a bounded `ready_s` phase to both; the
standby policy uses 120 s. One sample is not a distribution: the next
readiness (below) took 2.7 s.

## Second production run: promoted (journal `f4af49d7`)

| UTC | Event |
| --- | --- |
| 00:27:08 | Lease, admission and authority |
| 00:27:10 | `convert-app` already applied |
| 00:27:17 | `app-5091917968f7` (`stats-30a64ac4fac6`) activated; restart and collector wait 7 s |
| 00:27:20 | First readiness check passed (2.7 s) |
| 00:29:23 | 4 verification checks passed over 120 s; `promoted` |

Afterwards, independently of the controller: health and `/api/v1/hosts`
returned 200, all five hosts were reporting, all three collector sources were
fresh with `/run/stats-infra/release.json` naming the new app, and
`standby-engine inspect` matched the Engine declaration.

## Other findings

- `stats-infra-collector` was stopped from 22:40 to 23:15 on 2026-11-21:
  the documented Engine recovery stops `native-stats`, which stops the
  collector, and starting `native-stats` does not start it again. It was
  started under the lease and the runbook now includes it.
- App archives built by macOS `tar` carried `._*` AppleDouble files into every
  in-place release. Staged releases are now written by Python with root
  ownership; the leftovers in `/opt/native-rehearsal/app/` and the baseline
  release are inert.
- `/opt/native-rehearsal/releases/` holds eight directories from the retired
  script and is no longer used.
- Local test noise: `pytest-parallel` 0.4.0 reports passing tests as worker
  errors (PAR-17); `pytest -p no:parallel` runs Stuff's 170 tests green.

## Reproduce

```sh
export STATS_ROLLOUT=~/repos/laputa-systems/stuff/deploy/openorange/bin/rollout \
  STANDBY_SSH_CONFIG=~/.config/stats/standby/ssh_config \
  STATS_CHECK_CREDENTIAL_FILE=~/.config/stats/synthetic-check.json \
  STATSCTL=~/.local/state/openorange/rollout/tools/statsctl
make standby-deploy-check
make standby-deploy
"$STATS_ROLLOUT" status --run ~/.local/state/openorange/rollouts/RUN
```
