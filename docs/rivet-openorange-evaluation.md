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
- **R2 — accounting:** complete. `rowsWrittenBy` and its siblings split into
  logical `affectedBy` (DML RETURNING) for retention/cleanup/invalidation and
  genuine billing `meteredWritesBy`; regression coverage on both SQL adapters.
- **R3 — parity corpus: complete, with named platform differences.** The
  candidate passes 1444/1444 frozen assertions against a node/sqlite control
  over the full corpus; three honest gaps are recorded below (Analytics SQL,
  DO alarm timing, desktop/golden-image deltas). Tails deliver fetch
  invocations; per-operation attribution arrives via the explicit
  application-event adapter, not via diagnostics channels.
- **R4 — native control: complete.** One native actor persists fixtures,
  rolls back failed transactions, accumulates rollups, fires a scheduled
  tick, forks with storage copy + isolation, and survives an engine restart,
  matching the node/sqlite control on common inputs.
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
- DO `storage.setAlarm` delivery and diagnostics-channel error reports:
  see R3 section below. Application-event ingestion, outbound telemetry,
  deployment markers, and dashboard routes: exercised in R3; application
  events land in `/api/observe/stats/external`.

Candidate glue size: 308 nonblank source lines (`generate.mjs` 92 +
`pilot.mts` 216), plus 19 nonblank test lines, well under the 800-line
candidate cap and the dispatcher cap (122 nonblank lines).

## R2 — accounting: logical decisions separated from metered counters

`rowsWrittenBy` (cursor-delta on `SqlDatabase.rowsWritten()`) masqueraded a
trigger-inclusive, index-inclusive runtime meter as "rows deleted" for
retention batch fullness, backlog scheduling, cache invalidation and project
cleanup. On both SQL adapters it reported 2 for one logical `DELETE` behind an
`AFTER DELETE` trigger (reproduced before the change). It was renamed in
substance:

- `affectedBy` — bounded DML `... RETURNING 1` row count; drives every
  application decision (`purgeExpired`, retention/cleanup, invalidation).
- `meteredWritesBy` — the genuine Cloudflare billing signal, kept for
  Cloudflare cost reporting. Never read for application decisions.
- `recordRun` no longer returns an unused metered count.

Regression coverage on both adapters (Cloudflare workerd D1-proxy style
`CloudflareSql` and Node `DatabaseSync`): deletion counts 0/1/999/1000/1001
behind triggers and indexes, an unmetered `SqlDatabase` proof for retention
decisions, transaction rollback, stale-history ETag invalidation, and a no-op
alarm. File: `cloudflare/test/node/accounting.test.ts` (9 pass) plus two
cases in `cloudflare/test/cloudflare-sql.test.ts` (5 pass).

Not changed: persisted schemas, public producer types, wire data. Cloudflare's
genuine meters stay for Cloudflare reports.

## R3 — parity corpus: complete, with named platform differences

Command: `node scripts/rivet-eval.mjs parity --candidate openorange --json`;
also runnable as the opt-in test `test/rivet-eval/parity.test.ts`. Raw
compact evidence: [parity.json](rivet-openorange/parity.json) — revision
`5f3fc0b` (worktree clean), offline sandbox (`scripts/offline-run.sh`).

Design: the candidate was driven through the same corpus twice — once frozen
(`TEST_NOW_MS=1793510415000`, matching `wrangler.test.jsonc`) comparing
byte-for-byte against the Node `node:sqlite` control harness (the same
oracle `test/node/parity.test.ts` uses for workerd), and once in real time
for the CLI/producer/deployment workflows. Every fixture batch is ingested
first-delivery and as a replay; every history range/kind and bundle is
fetched; acknowledgments match the golden encoder frames
(`frames/acks/all-duplicates.sta2`).

Results — 1444 gated assertions pass, 0 fail; 5 informational record-only
checks (startup/restart timings, process list, RSS):

| Area | Evidence |
| --- | --- |
| Fixture corpus (40 batches, incl. u64-boundaries, partial-acceptance, semantic-rejects) | candidate ≡ control, ingest first-delivery + replay; ingest of `u64-boundaries` sample 3 is rejected on both by the documented 5-minute future `atMs` rule (`docs/protocol.md`), not by codec caps |
| History (5 ranges x 5 kinds + bundles) per host | byte-identical status/contentType/etag/body to the control for all 40 hosts |
| Latest / system / host list | identical to control |
| Malformed frames (65 cases from `fixtures/v2/malformed.json`) | identical 400 bodies to control; whole-frame rejection holds |
| Negative controls (write-loss, missing-metric, unmatched selector) | corrupted ack/history bytes throw in both arms (R1); `eq` flags a truncated history (lost acknowledged write) and a one-byte metric difference as unequal, plus etag/content-type/status changes; `run-tests.mjs --file test/does-not-exist.test.ts` exits 1 with `unmatched test selector`; opt-in test `cloudflare/test/rivet-eval/parity-controls.test.ts` |
| ETag / If-None-Match round trip; cache invalidation after mutation | 304 round trip; stale etag rejected with 200 after mutation |
| Restart durability | history bytes byte-identical after SIGTERM + restart; host list persists |
| Auth | JWT missing/invalid -> 401 on API and /assets; valid JWT -> 200 |
| Producer path (`/ingest/observe/v1/:service/batches`) | first 202 accepted 2, replay 200 duplicates 2; golden batch remapped to real now; service scope + provenance `application` |
| Deployment markers | 201 first, 200 idempotent replay (same deployment id) |
| Application events (explicit adapter) | 4 candidate operations visible at `/api/observe/stats/external` with `provenance: application`, `service: stats`, release `stats-eval-<rev>`, logical work fields; ingests ran on both ingest paths |
| CLI `statsctl check ingest` | full workflow (encode/ingest/ack/latest/history/replay/stored-count) exits 0 against the candidate |
| Observe pipeline | platform tail delivers fetch invocations (health shows 11 live invocations, ingestBatches counter nonzero) |
| Dashboard | 200 with auth, 401 without |
| workerd in candidate process tree | none; process tree is dev node + esbuild + runner(s) + rivet-engine + rivet-services (851 MB RSS sum) |

Platform differences found and their honest status:

1. **Per-operation attribution travels on application events, not tails.**
   OpenOrange's tail shim delivers invocation records (7d) but hard-codes
   `diagnosticsChannelEvents: []` and `cpuTime: 0`. Stats' interior operation
   marks only publish on a diagnostics channel when `tracing.getActiveSpan`
   exists; to keep attribution portable, the composition root publishes one
   application event per operation through the existing producer contract
   (`provenance: application`) when `APPLICATION_EVENTS_RELEASE` is set
   (experiments/rivet config sets it; production Cloudflare deployments do
   not). Durations are wall-clock application durations, never presented as
   platform CPU; logical work counts only.
2. **`tracing.getActiveSpan` did not exist on the candidate's
   `cloudflare:workers` shim** — every request 500'd before R1's repair; the
   span resolution is now capability-checked, which is a no-op on Cloudflare.
3. **CATCH error reports published on the diagnostics channel do not reach
   the observe service on the candidate** (the channel is dropped upstream).
   Failures surface as invocation exceptions in the tail instead; correct
   operation loss semantics are unproven. This is recorded as a platform
   limitation, not papered over. Note: caught-error telemetry on the
   candidate is degraded vs Cloudflare `cf` tails — see verdict section.

Still unproven on the candidate, explicitly not claimed:

- `ANALYTICS_SQL` (no local OpenOrange substitute; collector/projection path
  unproven; Analytics Engine remains Cloudflare-only).
- DO `storage.setAlarm` delivery (installation cleanup alarm; shortest real
  delay is ~10 minutes — not exercised in the parity window; tracked for
  R5b). The observe service's `CLEANUP_INTERVAL_MS` alarm is likewise not
  exercised.
- Linux target and musl ABIs (no verified Linux host; not authorized).
- WebP dashboard goldens vs candidate rendering (the golden image workflow
  stays the Cloudflare/Vitest reference; candidate dashboard was verified for
  auth + 200 HTML, not pixels).

Candidate glue size: 555 nonblank source lines in `experiments/rivet/`
(`generate.mjs` 95, `pilot.mts` 124, `harness.mts` 96, `parity.mts` 253,
plus config/manifest files), under the 800-line candidate cap; dispatcher
123 of 150.

## R4 — native Rivet control

Command: `node scripts/rivet-eval.mjs native --json` (also the opt-in test
`test/rivet-eval/native.test.ts`). Raw compact evidence:
[native.json](rivet-openorange/native.json) — revision `6bc9b57` (worktree
clean), pinned rivetkit 3.1.2-rc.1, engine binary `dbcbaac1…` (`Rivet 3.1.1`),
Services 0.2.5.

One native actor (`probe`), native SQLite through the Engine, fixtures from
`fixtures/v2`:

| Check | Result |
| --- | --- |
| Fresh actor starts empty | pass (0 rows) |
| Ingest linux-normal + u64-boundaries | pass — byte-identical row count and payload bytes to the `node:sqlite` control (5 rows, 4001 payload bytes) |
| Duplicate ingest is ignored | pass (`INSERT OR IGNORE ... RETURNING seq` → `written: 0`) |
| Failed transaction rolls back | pass — thrown transaction rejected client-side; row count unchanged |
| Rollup upsert accumulates (`ON CONFLICT ... RETURNING`) | pass (2 → 5 in same bucket) |
| Scheduled maintenance fires (`c.schedule.after` one shot) | pass (250 ms; fired logged) |
| Actor fork ×2 (bounded probe) | pass — forks start with the parent's storage (5 rows each); post-fork mutations isolated (parent 7 rows; children stay 5; markers parent/a/b) |
| Restart with same `RIVETKIT_STORAGE_PATH` | pass — 7 rows, payloadBytes 7218 byte-identical; marker and rollup intact |
| workerd in process tree | none (engine + envoy + services only) |
| Ingest timings | linux-normal 16 ms, u64-boundaries 6 ms (native); node control comparison same hot path |

API-level findings (not defects, limits of what R4 can claim):

- `RawAccess` exposes `execute`/`query`/`transaction` but **not**
  `commitTicket`/`whenDurable`; durability is acknowledged only by the engine's
  internal commit path. Evidence of durability is behavioral (engine restart
  preserves the exact bytes) — no acknowledgment API was available to assert on.
- `onMigrate` ran before actor start; forks copy the parent's SQLite, so all
  schema must be idempotent (`CREATE TABLE IF NOT EXISTS`) or fork starts fail
  by construction — the failure mode was demonstrated and repaired before this
  report.
- Sleep/wake hibernation is not exposed on the action API probed here; cron
  scheduling (as opposed to one-shot `schedule.after`) was not exercised.
- The fork demonstrated copy-then-isolate from the parent (rows + mutations);
  it is **not** an atomic snapshot of the Stats + observation actors, alarms,
  credentials or streams, and it was not used to imply one.
- No application integration: the Stats core was not ported; the native actor
  proves the platform's per-actor SQLite, transactions, scheduling, fork and
  restart semantics only — nothing about Stats as a whole on Rivet.

Cost of native adoption: adopting rivetkit natively means replacing the
Cloudflare-specific surfaces (Durable Objects → actors + `db()`, alarms →
`schedule`/`setWakeAt`, tails → nothing equivalent — interior events must move
to application-event ingestion or be lost, `cloudflare:workers` shims,
`nodejs_compat` semantics), plus the wrangler-style config toolchain. That is
a rewrite of the deployment boundary, not an import; R5 in this evaluation only
covers the packaged OpenOrange compatibility path, not a native rewrite.

## R5 — restart, offline, growth and a packaged process

Commands: `node scripts/rivet-eval.mjs resilience --quick --json` (R5a) and
`node scripts/rivet-eval.mjs resilience --soak-minutes 30 --reloads 100 --json`
(R5b). Raw compact evidence:
[resilience.json](rivet-openorange/resilience.json) — revision `79e9fb4`
(worktree clean).

R5a results (all pass):

| Check | Result |
| --- | --- |
| kill:app | SIGKILL 4 processes in the tree; acknowledged writes replayed as duplicates (`duplicates === 2`); history bytes 2776 |
| kill:engine | SIGKILL the Engine process; acknowledged writes replayed as duplicates (`duplicates === 2`) |
| kill:services | SIGKILL 3 Services processes; acknowledged writes replayed as duplicates (`duplicates === 2`) |
| isolatedSessions | two concurrent sessions; host created (201) in A; B's host list stayed empty; no shared identifiers or ports |
| offlineCanary | under `scripts/offline-run.sh` the packaged process served loopback (200) and non-loopback egress was denied (192.0.2.1); on macOS this is an OS-level claim only |
| packagedSelfHost | watcher-free `orange serve` against a driver-spawned local Engine (SQLite, self-host): restart produced byte-identical history (fingerprint match); 401 on missing JWT, 401 on bad JWT; unauthenticated probe of the Engine endpoint returned 404 |
| snapshotRestore | stop-the-world filesystem copy of the full synthetic state dir restored and replayed with duplicates === 2; **same-namespace** restore; no supported online export ran; labeled as such |

R5b (soak) is recorded in the behavior register (D4) and appended below once the
30-minute / 100-cycle run completes.

Limits (kept explicit):

- Alarm delivery across restart is not exercised (`storage.setAlarm`; shortest
  real delay ≥ 10 minutes).
- Fresh-namespace restore is unproven — no supported export API; the only
  restore demonstrated is a same-namespace stop-the-world copy.
- Receiver backlog under load is untested.
- macOS only; Linux/musl and multi-host remain open (Needs environment).

## Required behavior inventory

Frozen in [rivet-openorange-behavior-register.md](rivet-openorange-behavior-register.md)
before any candidate result existed. Categories A (portable, 15 rows),
B (platform sensor/billing, 5 rows), C (dev lifecycle, 5 rows), D (self-host,
8 rows). R1–R5 recorded; D5 fails as written; R6 (benchmark) pending.

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
