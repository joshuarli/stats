# Standby Engine alarm loop (2026-11-21, live)

STA-135 reproduced on the authoritative standby without a drill. The data API
returned `503 storage_unavailable` (`retry-after: 5`) while `/health` answered
200. The documented recovery restored both, and no service configuration,
Engine state or production selection was changed.

## Evidence

Protected snapshot and the 4-hour Engine log remain under
`/var/lib/live-stats-recovery/sta135-20261121-loop/` in the standby guest:

| File | SHA-256 |
| --- | --- |
| `snapshot.txt` | `e28c7f62630822238d1345480e173a817ea1f1cc9ed1fd036f5b171d7f62dacc` |
| `engine-4h.log` | `98b1391b3254062f82aed30402879f5211826e3f9384d24c8d1fc7e9db20a9df` |

At 22:40:21 UTC the guest load was 4.37 on 32 cores. `live-stats-engine` was at
403.38% CPU against its 4-CPU cap (image `sha256:6e585002b700...`,
`nanoCpus=4000000000`, memory 3 GiB). It had not restarted. The 4-hour log
(18:40:24–22:40:21) contains:

| Message | Count |
| --- | ---: |
| `refusing envoy connect that storage could not register` | 4,502 |
| `Envoy connection closed` | 4,502 |
| `volume alarm callback failed; the unacknowledged alarm will retry` | 1,944 |
| `depot command failed with an unstructured error` (`pegboard.actor.create`) | 860 |
| `tablet client cold reads near their window ... raise depot.max_cold_reads` | 232 |
| `envoy disconnect write failed` | 37 |

The earliest matching warning in the preceding four hours was at 18:30:27 UTC.
In the final 30 minutes there were 573 envoy refusals, 1,257 deadline errors
and 57 `command_capacity` refusals. No fence, fatal error or restart appears in
the log. `perf` and `strace` are not installed in the guest, so no native stack
profile was captured.

## Recovery

Following `docs/openorange.md#standby-incident-2026-11-21`:

1. 22:40:54 — `rc-service native-stats stop` (also stops `stats-infra-collector`).
2. Engine CPU fell 396% → 279% → 142% → 72% → 1.27% by 22:42:05, well before
   the host load changed. This is the first clean evidence that the spin is
   sustained by the application's registration pressure rather than by host
   load alone.
3. 22:42:16 — `rc-service native-stats start`.

Verification at 22:43:29: `/health` and `/api/v1/hosts` both 200, zero matching
Engine warnings in the preceding minute, and four of five expected hosts
reporting within five minutes (`tim` remains stale, as before the incident).
Engine CPU was 126%, still above its idle baseline; no config lever was applied.

## Open

- The initial depot refusal and the 100% CPU spin are still unexplained. The
  232 cold-read warnings point at the `storage.max_background_cold_reads` lever
  ranked in Stuff's `docs/openorange-engine-degradation.md`, but no lever was
  tried here.
- The loop occurred at low host load, so a contention-only reproduction is not
  sufficient. A consistent-depot drill is still needed, but the live capture
  was not run during an incident.
- The original stopped depot and all recovered state were left untouched.
