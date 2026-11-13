# Rivet 3 / OpenOrange evaluation: behavior register

Classification frozen November 13, 2026, before any candidate result was
observed (R1 has produced none). A required row that fails rejects the affected
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
| A1 | A | STB2/STA2 fixture parity, exact u64/bigint boundaries (`fixtures/v2/`, docs/protocol.md) | `test/binary/*`, `test/ingest/conformance.test.ts`, `test/node/parity.test.ts` | required | pass (baseline); candidate pending |
| A2 | A | Malformed frames reject whole (no partial ingest) | `fixtures/v2/` negative corpus, `test/ingest/*` | required | pass (baseline); candidate pending |
| A3 | A | Canonical duplicate identity; conflicting retry rejected; retry of failed delivery idempotent | `test/ingest/acks.test.ts`, `test/local/scenarios.test.ts`, `test/services.test.ts` | required | pass (baseline); candidate pending |
| A4 | A | SQL transactions, rollback, dedupe; Node/SQLite and Cloudflare adapters | `test/cloudflare-sql.test.ts`, `test/node/*`, docs/protocol.md | required | pass (baseline); candidate pending |
| A5 | A | History: bytes, decoded values, ETags, time boundaries, out-of-order inputs | `test/history*.test.ts`, `test/history-frame.test.ts`, `test/node/*` | required | pass (baseline); candidate pending |
| A6 | A | Rollups and current-window aggregates | `test/aggregate.test.ts`, `test/projects-series.test.ts`, `test/chart-data.test.ts` | required | pass (baseline); candidate pending |
| A7 | A | Scheduled cleanup and maintenance survive restart; bounded backlog | `test/local/collection.test.ts` (S6), `test/local/upgrade.test.ts`, `test/node/*` | required | pass (baseline); candidate pending |
| A8 | A | Offline: undeclared outbound refused; `scripts/offline-run.sh` OS sandbox | `test/local/outbound.test.ts`, `test/local/topology.test.ts`, docs/testing.md | required | pass (baseline); candidate pending |
| A9 | A | Analytics SQL: deterministic fixture, unknown query/params fail, no silent remote fetch | `test/local/collection.test.ts`, `cloudflare/local/analytics.ts` | required | pass (baseline); candidate pending |
| A10 | A | Auth and routing: local auth fixture valid/invalid; protected API and assets; unauthenticated bypass refused | `test/access.test.ts`, `test/api.test.ts`, `test/local/*`, `test/ui/*.spec.ts` | required | pass (baseline); candidate pending |
| A11 | A | Service ingest contract (`docs/integration.md` §§1–9): retries, idempotency/conflicts, caps, service scope, provenance | `test/services.test.ts`, `test/local/scenarios.test.ts`, `test/observe-e2e/*`, `packages/producer/` | required | pass (baseline); candidate pending |
| A12 | A | Observation: real operations recorded, attributed, deduplicated, retained, queryable; gaps explicit | `test/observe/*`, `test/observe-e2e/*`, `src/observe/` | required | pass (baseline); candidate pending |
| A13 | A | Application-event ingest: `/ingest/observe/v1/:service/batches` contract, deployment comparison | `test/services.test.ts`, `test/deployments/*`, `test/observe/*` | required | pass (baseline); candidate pending |
| A14 | A | Dashboard and CLI: seeded routes, missing states, auth, errors; WebP goldens unchanged reference | `test/ui/local-stack.spec.ts`, `test/cli/*`, `test/cli-worker.test.ts` | required | pass (baseline); candidate pending |
| A15 | A | Node/SQLite adapter parity as non-Cloudflare diagnostic control | `test/node/*` | optional control | pass (baseline) |
| B1 | B | Per-invocation CPU / billable writes/rows (Cloudflare platform meters) | `test/operations.test.ts`, `src/operations.ts` | optional; unavailable on candidate (never 0) | intentional difference |
| B2 | B | Billing-counter vs logical mutation distinction (`rowsWrittenBy`) | `src/operations.ts`, `docs/protocol.md` | optional; candidate may report logical counts only | R2 separates; intentional difference |
| B3 | B | workerd/Miniflare runtime, compatibility dates, nodejs_compat | `cloudflare.config.ts`, `docs/dev-loop-results.md` | optional; candidate runs native Rivet | intentional difference |
| B4 | B | Real Cloudflare Analytics/billing pipeline | production only | optional; local fixture substitute | not evaluated locally |
| B5 | B | Platform tail fidelity (DO/alarm/RPC traces, CPU=0, no diagnostics-channel events) | OpenOrange tail workers doc (dated in campaign doc) | optional; application-event adapter acceptable | intentional difference |
| C1 | C | `make dev` frontend HMR without backend rebuild | `bench/dev-loop.ts` frontend-edit; docs/development.md | required (Cloudflare default preserved) | pass |
| C2 | C | Backend edit rebuilt and served | `bench/dev-loop.ts` worker-edit | required (Cloudflare default preserved) | pass |
| C3 | C | Observation edit rebuilt and served | `bench/dev-loop.ts` observation-edit | required (Cloudflare default preserved) | pass |
| C4 | C | State ownership, isolation, reset; no concurrent writers | `test/scripts/development.test.ts`, docs/development.md | required | pass |
| C5 | C | Toolchain pins and doctor (`.node-version`, dev-doctor) | `make dev-doctor` | required | pass |
| D1 | D | Packaged watcher-free candidate vs local Engine; same authenticated pilot and restart | `experiments/rivet/`, `node scripts/rivet-eval.mjs resilience --quick --json` (R5a) | required for self-host verdict | pending |
| D2 | D | Acknowledged host writes survive kill of app/Engine/Services; retries do not duplicate or corrupt | R5a kill tests | required for self-host verdict | pending |
| D3 | D | Offline execution: credentials stripped, non-loopback OS-denied (macOS `scripts/offline-run.sh`); runtime/update checks and telemetry exporters denied | R5a offline tests | required for self-host verdict | pending |
| D4 | D | 30-minute bounded soak, 100 reload cycles, retention bounded, no unexplained growth | `resilience --soak-minutes 30 --reloads 100` (R5b) | required for self-host verdict | pending |
| D5 | D | Backup/restore into fresh namespace from supported consistent export of synthetic data | R5a/R5b | required for self-host verdict | pending |
| D6 | D | No cross-run interference; no orphaned listeners; two isolated sessions | R5a | required for self-host verdict | pending |
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
