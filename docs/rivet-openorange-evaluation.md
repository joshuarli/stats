# Rivet 3 / OpenOrange evaluation

Verdicts (filled by R7):

- **Local default:** pending (R1–R6)
- **Self-host path:** pending (R5a/R5b)

Status by slice:

- **R0 — freeze baseline: complete.** Attribution, candidate
  closure pins and the required-behavior inventory are recorded below.
- **R1 — OpenOrange pilot: complete, with named limits.** The real Stats
  ingest/history path runs on the pinned candidate under the offline
  sandbox; details below. Analytics SQL and tails/observation are unproven;
  Linux untested.
- **R2 — accounting:** not started. **R3 — parity corpus:** not started.
- **R4 — native control:** not started. **R5a/R5b — resilience/soak:** not started.
- **R6 — measurement:** not started. **R7 — verdict:** not started.

Raw machine-readable evidence lives in `docs/rivet-openorange/`. Run-time
scratch lives under `.work/rivet-eval/<run>/` and is disposable.

## Environment note

The checkout pins Node `26.13.1` in `.node-version`; this host's global `node`
is `v26.13.0` (Homebrew `node@26` is `v26.12.0`). All campaign commands ran
under the official `node-v26.13.1-darwin-arm64` toolchain installed into
`.work/toolchain/` (SHA-256 `aec2514e…`, verified against nodejs.org
SHASUMS256.txt); global installations were not modified. pnpm is `12.18.0`.

## Baseline (A) — post-handoff Cloudflare path — measured 2026-11-13

Command: `node scripts/rivet-eval.mjs baseline --json --runs 5`
(dispatcher forwards to `cloudflare/bench/dev-loop.ts --phase candidate`;
the improved loop is the reference, not the pre-handoff one).

Raw: [baseline.json](rivet-openorange/baseline.json) — revision `a6979b6`
(worktree clean), harness SHA-256 `ce483cd5276774ac5e32755c5faab0cdcd087b6c831cfe59b90f402240fc6ae0`,
lockfile SHA-256 `055ebf0d…`, fixtures manifest SHA-256 `bd3a106e…`.
Host: Darwin 27.0.0 arm64, Apple M5 Max, 18 cores; Node v26.13.1; pnpm 12.18.0;
SQLite 3.54.1. Runtime group: Miniflare 5.20261110.2-beta, workerd 1.20261110.1,
Vite plugin 2.0.0-beta.v.16, Vitest plugin 1.8.1, cf 1.0.0-beta.31; supported
compatibility date 2026-11-10 (source workerd); configured date 2026-10-30.

Median [min–max], ms. Five alternating runs, every trial passed host readiness
checks. Timed before/after each trial with `perf-gate-ready`.

| Scenario | Median | Range | Compilations |
| --- | ---: | --- | --- |
| Cold readiness | 1937 | 1794–3597 | 2 |
| Warm readiness | 927 | 919–986 | 0 |
| Frontend edit (HMR) | 57 | 29–135 | 0 |
| Backend (stats) edit | 1312 | 1238–1457 | 1 |
| Observation edit | 1072 | 1054–1234 | 1 |
| Unchanged build | 120 | 107–125 | 0 |
| Focused ingest conformance (3 tests) | 276 | 255–281 | 0 |
| Focused Worker/Node parity (1 test) | 2644 | 2581–3101 | 2 |

Warm process-tree RSS: 717–726 MiB across three processes (sum of resident
sets; shared pages may double-count). Not a physical-memory or leak measure.

Focused-test check: `node cloudflare/scripts/run-tests.mjs --file test/ingest/conformance.test.ts --file test/node/parity.test.ts` — 4/4 pass, ~1.9 s.

Known-red / diagnostics:

- `rowsWrittenBy` on node:sqlite returns 2 for one logical `DELETE` with an
  `AFTER DELETE` trigger (reproduced 2026-11-13 from the repository root with
  the snippet in `docs/CAMPAIGN-RIVET-OPENORANGE.md`), while `changes()`
  reports 1. This is the accounting coupling R2 removes; it is not a failing
  test and not evidence of production data loss.
- No baseline test failures were observed. `make check` has not yet been run
  on this HEAD by this campaign; M1 runs it after R2/R3 integrate.
- Baseline comparison uses `a6979b6` (adds the dispatcher and the
  observation-edit scenario). The dev-loop verification numbers in
  `docs/dev-loop-results.md` (measured at `c63f2ce`, 5 trials, 903 ms warm
  readiness) are not a fresh R0 run and are kept as attribution evidence only.

## Candidate closure — pinned at R0

Registry: `sfw.security.sentry.io/npm/` (the repository's configured proxy).
Command: `node scripts/rivet-eval.mjs bootstrap --json` — the only
network-capable dependency command; measured execution runs offline.

Raw: [bootstrap.json](rivet-openorange/bootstrap.json) — revision `a6979b6`.

| Package / artifact | Version | Notes |
| --- | --- | --- |
| open-orange | 1.0.1 | Apache-2.0; `latest`=1.0.1 at inspection; pins rivetkit 3.1.2-rc.1 |
| rivetkit | 3.1.2-rc.1 | Apache-2.0; rc line pulled by open-orange 1.0.1 |
| @rivetkit/engine-cli | 3.1.2-rc.1 | Apache-2.0; `rivet-engine` binary sha256 `dbcbaac1…`, 65,977,440 bytes; binary self-reports `Rivet 3.1.1` (package/binary version mismatch recorded, not hidden) |
| @rivet-dev/services | 0.2.5 | registry license `UNLICENSED`; optional per rivetkit metadata; resolved once from `^0.2.5`, pinned exact |
| wrangler | 4.129.0 | transitive via open-orange; not executed by the pilot path |

The closure requires the prerelease line; pnpm recorded 21 exact-version
`minimumReleaseAgeExclude` entries in `experiments/rivet/pnpm-workspace.yaml`
for the candidate's own packages (the same mechanism the repository uses for
its approved beta group). No global release-age override was added. Effective
build policy, carried from the repository and closed under `--ignore-workspace`:
allow `esbuild` and `workerd` (repository policy), explicitly deny
`@google/genai`, `better-sqlite3`, `cbor-extract`, `protobufjs`. Verification:
nothing in the closure imports `better-sqlite3` (optional drizzle-orm peer,
unused at runtime); `cbor-extract` is optional accel for `cbor-x` with a pure
JS fallback; `protobufjs` and `@google/genai` scripts are no-op telemetry/stub
scripts. Frozen lockfile is committed at `experiments/rivet/pnpm-lock.yaml`;
bootstrap verifies the application `package.json`, `pnpm-lock.yaml`,
`pnpm-workspace.yaml` and `cloudflare/package.json` are byte-identical before
and after install.

Engine CLI ships darwin-arm64/x64 and linux-x64/arm64 musl binaries; Services
ships darwin x64/arm64 and linux x64/arm64 GNU binaries. Linux is unavailable
on this host; ABI suitability on Linux is unproven (see Needs environment).

## R1 — real OpenOrange pilot — measured 2026-11-13

Command: `node scripts/rivet-eval.mjs pilot --candidate openorange --json`
(forwards to `experiments/rivet/openorange/pilot.mts`). Raw:
[pilot.json](rivet-openorange/pilot.json) — revision `a416f58~1`+mark fix,
open-orange 1.0.1, rivetkit 3.1.2-rc.1, engine binary `dbcbaac1…`
(self-reports `Rivet 3.1.1`), services 0.2.5 (`protocolVersion` 8,
`rivetkitVersion` 3.0.0).

Flow: build outputs → generate Wrangler-compatible descriptors from the
authoritative `worker.config.json` of both Workers (rejecting unmapped
fields) → `orange dev --json --config stats.jsonc --config observe.jsonc`
under `scripts/offline-run.sh` (credentials stripped; non-loopback network
denied; macOS only) → seeded assertions → SIGTERM → fresh process on the same
state → identical history again.

| Check | Result |
| --- | --- |
| Ready under offline sandbox | 3583 ms, origin 127.0.0.1 loopback |
| `GET /health` | 200 |
| Authenticated host create (`/api/v1/admin/hosts`) | 201 |
| STB2 batch ingest | 200; ack accepted 2, duplicates 0 |
| Replay | 200; duplicates 2, accepted 0 |
| Conflicting retry (same seqs, changed payload) | 400; `conflict` ×2 |
| History through `openHistory` decoder | 200; `application/vnd.stats.history.v1` |
| Byte-identical history after SIGTERM + restart | yes (2776 bytes, both runs) |
| Host list persists across restart | 1 host |
| workerd in candidate process tree | none (dev node → esbuild service, runner.js ×2, rivet-engine, rivet-services) |
| Negative control: corrupted ack / history bytes | decoder throws in both |
| Warm process-tree RSS | 860 MB KiB sum (dev + engine + runners + services; shared pages may double-count) |

Candidate incompatibilities found and repaired (one attempt each, portable):

1. `tracing.getActiveSpan` is absent from the candidate `cloudflare:workers`
   shim; every request threw `TypeError` → 500. Repaired in
   `cloudflare/src/observe/cloudflare/mark.ts`: the active span is resolved
   through a capability check; where the host exposes no span API, invocation
   and operation marks are omitted (unavailable, not zero). Behavior on
   Cloudflare is unchanged. Verified against the existing ingest/parity
   selection (4/4 pass) and typecheck.

Toolchain quirks recorded: `orange dev --json` emits JSON Lines
(type=config/warning/ready/request/log/stopped); the candidate spawns the
pinned Rivet Engine itself (`rivet-engine --config .open-orange/.../config.json`)
and `rivet-services` for streams; first run DB creation takes seconds;
SIGTERM stops the whole tree within seconds; no S3 or Rivet Cloud needed.

Not proven on the candidate (recorded, not hidden):

- `ANALYTICS_SQL` is unbound — OpenOrange has no local Analytics SQL
  substitute and remote Analytics is not a local binding; collector pipeline
  unproven. The pilot drops the binding explicitly and reports it.
- Tail/observation delivery to the second Worker is untested (R3 scope).
- Linux target and musl ABIs untested (no verified Linux host; not
  authorized to provision one).
- Application-event ingestion, outbound telemetry from the candidate,
  deployment markers, and dashboard routes on the candidate: not yet run.

Candidate glue size: 308 nonblank source lines (`generate.mjs` 92 +
`pilot.mts` 216), plus 19 nonblank test lines, well under the 800-line
candidate cap and the dispatcher cap (122 nonblank lines).

## Required behavior inventory

Frozen in [rivet-openorange-behavior-register.md](rivet-openorange-behavior-register.md)
before any candidate result existed. Categories A (portable, 15 rows),
B (platform sensor/billing, 5 rows), C (dev lifecycle, 5 rows), D (self-host,
8 rows). Candidate results pending R1–R6.

## Needs environment

- Linux target, including declared musl support: no verified Linux host for
  this task; not authorized to provision one. `node scripts/rivet-eval.mjs
  resilience --target linux --json` remains the planned check.
- OS-enforced network isolation off macOS: `scripts/offline-run.sh` supports
  only macOS sandbox-exec; on Linux the app-level outbound guard alone gives
  no full offline claim (STA-83).
- Packaged watcher-free self-host on an unavailable target: no verdict from
  a dev server only.
- Multi-host durability, object-store cost, live Cloudflare parity: not
  authorized here; runbook only.
