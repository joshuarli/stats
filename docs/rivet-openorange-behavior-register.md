# Rivet 3 / OpenOrange evaluation: behavior register

Classification frozen November 13, 2026, before any candidate result was
observed (rows updated as slices land; the R3 re-freeze was recorded with the
campaign evidence). A required row that fails rejects the affected
recommendation after the two-attempt repair bound; a failure cannot reclassify
a required row. Optional/platform rows are excluded from comparisons that
require them and must instead present honest unavailable/difference behavior.

Categories:

- **A — portable application:** must pass on any conforming backend for an
  adoption recommendation.
- **B — Cloudflare-specific sensor/billing:** not portable; the candidate may
  report them unavailable (never zero) or differently. Intentional difference,
  not a parity failure.
- **C — development lifecycle:** the local edit loop. `make dev` keeps the
  Cloudflare path; candidate launches are experiments.
- **D — self-host operation:** durability and operability of a candidate
  running outside Cloudflare.

Oracles are the existing contracts and fixtures; tests reference the existing
suites rather than duplicating their cases. Result column is updated per slice
with the slice's evidence; `pending` means not yet executed.

| # | Category | Behavior (oracle) | Evidence / test | Status | Result |
| --- | --- | --- | --- | --- | --- |
| A1 | A | STB2/STA2 fixture parity, exact u64/bigint boundaries (`fixtures/v2/`, docs/protocol.md) | `test/binary/*`, `test/node/parity.test.ts`; candidate: `parity.json` ingest:* | required | pass (baseline and candidate) |
| A2 | A | Malformed frames reject whole (no partial ingest) | `fixtures/v2/malformed.json` 65 cases, A/B byte-equal: `parity.json` malformed:* | required | pass (baseline and candidate) |
| A3 | A | Canonical duplicate identity; conflicting retry rejected; retry of failed delivery idempotent | `test/ingest/acks.test.ts`; candidate: replay ≡ golden ack; conflict retry A/B equal (`parity.json` conflictingRetry, replayMatchesGoldenAck) | required | pass (baseline and candidate) |
| A4 | A | SQL transactions, rollback, dedupe; Node/SQLite and Cloudflare adapters | `test/node/accounting.test.ts`, `test/cloudflare-sql.test.ts` (R2); candidate ingest path A/B equal; cleanup/alarm scheduling pending DO-alarm proof | required | pass (baseline); candidate ingest path pass, maintenance pending |
| A5 | A | History: bytes, decoded values, ETags, time boundaries, out-of-order inputs | candidate history 1200 checks + ETag round trip + post-mutation invalidation A/B equal (`parity.json`) | required | pass (baseline and candidate) |
| A6 | A | Rollups and current-window aggregates | `test/aggregate.test.ts`; candidate history views byte-equal to control (rollups rebuild path exercised by frozen corpus) | required | pass (baseline and candidate) |
| A7 | A | Scheduled cleanup and maintenance survive restart; bounded backlog | `test/local/collection.test.ts`; candidate: restart proven; DO `setAlarm` delivery unproven (>=10 min real delay; tracked for R5b) | required | pass (baseline); candidate pending (blocked on DO alarm delivery proof) |
| A8 | A | Offline: undeclared outbound refused; `scripts/offline-run.sh` OS sandbox | all candidate sessions ran under `scripts/offline-run.sh` (credentials stripped, non-loopback denied); OS-level outbound canary deferred to R5a | required | pass (baseline and candidate offline sandbox); R5a canary pending |
| A9 | A | Analytics SQL: deterministic fixture, unknown query/params fail, no silent remote fetch | candidate: binding deliberately unbound (no local OpenOrange Analytics SQL substitute); collector/probe path unproven | required | pass (baseline); candidate unavailable — not evaluated |
| A10 | A | Auth and routing: local auth fixture valid/invalid; protected API and assets; unauthenticated bypass refused | candidate: missing/invalid JWT 401; valid JWT 200 on API, /, /assets/*; dashboard protected (`parity.json`) | required | pass (baseline and candidate) |
| A11 | A | Service ingest contract (`docs/integration.md` §§1–9): retries, idempotency/conflicts, caps, service scope, provenance | candidate: provision + golden batch first 202/replay 200 duplicates 2; deploy marker 201/200 idempotent; service scope; control-plane port probe deferred to R5a | required | pass (baseline and candidate ingest contract); bypass probe pending R5a |
| A12 | A | Observation: real operations recorded, attributed, deduplicated, retained, queryable; gaps explicit | candidate: tail shows fetch invocations (11 live, 12 ingest batches); operations attributed via explicit application-event adapter (`provenance: application`, release `stats-eval-*`) visible at `/api/observe/stats/external`; caught-error reports on diagnostics channel dropped upstream — named gap, not papered over | required | pass with named gaps (operation attribution via adapter; caught-error telemetry unavailable) |
| A13 | A | Application-event ingest: `/ingest/observe/v1/:service/batches` contract, deployment comparison | ingest contract verified (retries, dedupe, caps via adapter); deployment comparison surface not yet exercised on candidate | required | pass (ingest); deployment comparison pending |
| A14 | A | Dashboard and CLI: seeded routes, missing states, auth, errors; WebP goldens unchanged reference | candidate: dashboard 200/401 with/without auth; `statsctl check ingest` full workflow exits 0; pixel goldens not run on candidate | required | pass (baseline); candidate pass for routing/auth/CLI; goldens unproven |
| A15 | A | Node/SQLite adapter parity as non-Cloudflare diagnostic control | `test/node/*` | optional control | pass (baseline) |
| B1 | B | Per-invocation CPU / billable writes/rows (Cloudflare platform meters) | candidate tail shim hard-codes `cpuTime: 0` — a false zero presented as data; logical counts used instead; Cloudflare path unchanged | optional | intentional difference — candidate reports unavailable/0 upstream; not used for decisions |
| B2 | B | Billing-counter vs logical mutation distinction (`rowsWrittenBy`) | `src/operations.ts`, `docs/protocol.md` | optional; candidate may report logical counts only | R2 separates; intentional difference |
| B3 | B | workerd/Miniflare runtime, compatibility dates, nodejs_compat | `cloudflare.config.ts`, `docs/dev-loop-results.md` | optional; candidate runs native Rivet | intentional difference |
| B4 | B | Real Cloudflare Analytics/billing pipeline | production only | optional; local fixture substitute | not evaluated locally |
| B5 | B | Platform tail fidelity (DO/alarm/RPC traces, CPU=0, no diagnostics-channel events) | candidate tails deliver fetch invocations; `diagnosticsChannelEvents: []`; `cpuTime: 0`; adapter carries interior operations | optional | application-event adapter in use; difference preserved and recorded |
| C1 | C | `make dev` frontend HMR without backend rebuild | `bench/dev-loop.ts` frontend-edit; docs/development.md | required (Cloudflare default preserved) | pass |
| C2 | C | Backend edit rebuilt and served | `bench/dev-loop.ts` worker-edit | required (Cloudflare default preserved) | pass |
| C3 | C | Observation edit rebuilt and served | `bench/dev-loop.ts` observation-edit | required (Cloudflare default preserved) | pass |
| C4 | C | State ownership, isolation, reset; no concurrent writers | `test/scripts/development.test.ts`, docs/development.md | required | pass |
| C5 | C | Toolchain pins and doctor (`.node-version`, dev-doctor) | `make dev-doctor` | required | pass |
| D1 | D | Packaged watcher-free candidate vs local Engine; same authenticated pilot and restart | `experiments/rivet/`, `node scripts/rivet-eval.mjs resilience --quick --json` (R5a) | required for self-host verdict | pass — byte-identical history across restart; 401 on missing/bad JWT; engine endpoint unauthenticated probe 404 |
| D2 | D | Acknowledged host writes survive kill of app/Engine/Services; retries do not duplicate or corrupt | R5a kill tests | required for self-host verdict | pass — SIGKILL app (4), Engine (1), Services (3); acknowledged writes replayed as duplicates (=== 2); history bytes 2776 |
| D3 | D | Offline execution: credentials stripped, non-loopback OS-denied (macOS `scripts/offline-run.sh`); runtime/update checks and telemetry exporters denied | R5a offline tests | required for self-host verdict | pass — loopback 200, 192.0.2.1 denied under macOS sandbox-exec; telemetry exporter absence not separately probed; on Linux the app-level guard alone is not a full offline claim |
| D4 | D | 30-minute bounded soak, 100 reload cycles, retention bounded, no unexplained growth | `resilience --soak-minutes 30 --reloads 100` (R5b) | required for self-host verdict | pass — 100 reload cycles across 30 minutes, 200 samples accepted, 0 rejected, peak process-tree RSS 923,920 KiB (gate 4 GiB); restart replay duplicates === 2 |
| D5 | D | Backup/restore into fresh namespace from supported consistent export of synthetic data | R5a | required for self-host verdict | fail — no supported export API; only a same-namespace stop-the-world filesystem copy was demonstrated; fresh-namespace consistent export not produced |
| D6 | D | No cross-run interference; no orphaned listeners; two isolated sessions | R5a | required for self-host verdict | pass — host created (201) in session A; B's host list stayed empty; no shared ports/identifiers/orphans observed |
| D7 | D | License/maintenance/transitive closure vetted; package/bytes/time costs recorded | bootstrap evidence; R7 report | required for verdict | partial (bootstrap recorded) |
| D8 | D | Multi-host durability / object-store cost / live Cloudflare parity | out of scope (Needs environment) | not authorized | not applicable |

Notes and freezing rules:

- A positive candidate verdict requires every required A row executed and
  passing on identical inputs with independently isolated state, plus the R5
  self-host rows for a self-host verdict.
- Platform exceptions (B rows) must be named, tested for honest presentation
  (unavailable, not zero), and excluded from time/memory comparisons that
  require them.
- The candidate's path cannot ship as a `make dev` mode; C rows are about
  preserving the current default, not adding `dev-rivet`.
- Rows pending at R0/R1 that later prove a required incompatibility are
  recorded as demonstrated rejections (D12), never silently dropped.
