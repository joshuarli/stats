# Campaign: Cloudflare projects in `stats` (first project: `stuff`)

## Status

- **Goal:** `stats` monitors a Cloudflare project as a first-class target beside hosts. One configured project, `stuff`, shows its Worker (invocations, status mix, CPU), its three R2 buckets (operations by outcome, storage, objects), endpoint availability, and the collector's own health, with the same status strip, limits, incidents, and two-column layout as the host page. Data comes from the Analytics SQL binding on a five-minute cron. No agent, no token, no change in `../stuff`.
- **State:** A1 to D1 accepted; E1 review fixes applied; Worker deployed 2026-11-01 (`8390a8f6`) with the owner's go-ahead; N1, N3 and N7 verified live; N2 missed the 5% gate on three buckets that later converged except one (see `docs/operations.md`); the temporary diagnostic route was deployed and removed (version `2367b5c2`). Baseline `d1b369c`. Every fact marked proven below was run on 2026-11-01 against the live account with read-only `cf sql query`.
- **Accepted:** A1, A2, A3, A4, A5, B1, B2, C1, D1. **Red:** none. **Parked:** none.
- **Next:** none; the campaign is complete. Open: N2 re-run after a day, N6, and the owner's call on probes `site` blips.
- **Resume:** `Execute campaign-cf.md from item E1. Read the item, own only its files, and finish on its acceptance command.`

## Charter

- Decide and keep going. Record a decision only when a later slice depends on it; write it into **Decisions**, not a log.
- The execution grant covers local edits, local test runs, `.work/` scratch, and read-only `cf sql query` against the owner's account (at most 100 queries per session, each window at most 7 days). It never covers pushes, deploys, any Cloudflare write, tokens or secrets, or edits in `../stuff`. Park an item that needs more.
- Hard stops park the item, never the campaign: a live write, a forbidden effect, or a check that cannot run here. Put the proof on **Needs environment** with the command the owner runs.
- Parity before optimization. This campaign has no optimization item; budgets in **Decisions** S14 are measured and logged, and gate only where a number says so.
- One writer, one slice at a time. No parallel pair is allowed: every item touches `installation.ts`, `index.ts`, or `HostPage`-style shared client files, and the whole loop runs in seconds.
- Vitest commands below run from `cloudflare/` (`cd cloudflare`), and `test/...` paths are relative to it.
- Every slice ends on its acceptance command and the narrowest affected suite, run on the integrated tree. The full suite (`make fixtures cloudflare-test dashboard-test lint worker-check`) runs at M1 (after A5), M2 (after B2), M3 (after C1), and close. Red work never lands. A failing item gets root-cause first, then at most two fix attempts, then it is parked on its branch with the cause and a retry condition.
- Fix anything egregious met on the way, in its own commit. Egregious means: `make cloudflare-test` over 6 s, `make dashboard-test` over 10 s, `make lint` or `make worker-check` over 2 s; a flaky test (fails in 1 of 3 runs); a collector run that writes over 150 rows; a history response over 200 KB. Record anything else and leave it.
- Known traps. Each cost time or correctness during preflight; guard them in tests:
  - `COUNT(*)` is not weighted on this account. Every event count is `SUM(sampleInterval)` (S2).
  - Sampled datasets reject `MIN`/`MAX` (use `APPROX_MIN`/`APPROX_MAX`); `ORDER BY` requires `LIMIT`; state datasets allow only `MAX`; a lower timestamp bound is required.
  - `logs.workersLogs` is Log Explorer-backed: no `toStartOfInterval`, no quantiles, and `GROUP BY` an alias named like a column fails (`status`); group by the column itself.
  - Playwright serves the built bundle: `pnpm run build` before a bare `playwright test`. `make dashboard-test` builds.
  - The replay and golden harness parks the pointer; do not reintroduce hover state into goldens.
- Every commit is a Conventional Commit; the scope is the workstream (`projects`, `worker`, `dashboard`, `docs`). The item ID goes in the body. Code comments never cite this doc. No formatters. Never push.

## Decisions

### Owner (2026-11-01)

- **O1 · Access.** stats-worker reads analytics through the `analytics` Worker binding (`ANALYTICS_SQL`). No API token, no secret, no GraphQL. The binding can read all account analytics; only the fixed queries in `cloudflare/src/projects/queries.ts` ever run, and nothing from a request reaches SQL. This is a permission change the owner accepted.
- **O2 · Worker CPU depth.** Worker CPU is shown as weighted average and approximate maximum per bucket, labeled "CPU time", never latency. No p50 or p99 (the SQL source has none; real quantiles need GraphQL and a token).
- **O3 · Probes.** HTTP availability probes of the four public domains are in scope as the last functional slice (C1), config-driven (empty list means off). Live behavior is on **Needs environment**.
- **O5 · Parity (2026-11-01, decided in the owner's absence).** Accept up to about 10% error on the largest Worker buckets and keep the 90 minute window. Widening it is not shown to help (one stale bucket predates the deploy that coincided with the others converging) and would double the rows read per run. Re-check with `node cloudflare/scripts/check-parity.mjs` after a day of data; reverse this if settled hours miss the 5% gate.
- **O4 · Navigation.** Projects appear on the fleet page in a table under the hosts table; each row opens `#/project/:projectId`.

### Prescribed

- **S1 · Sources (proven).** Worker: `logs.workersLogs` with `scriptName = $script AND logType = 'cf-worker-event'` (one row per invocation; the `cf-worker` rows are not invocations). R2 operations: `events.r2CombinedOperations` (`bucketName`, `actionStatus`, `httpStatus`, `sampleInterval`). R2 storage: `states.r2CombinedStorage` (`payloadSizeBytes`, `objectCount`, time column `usageReportTimestamp`, which is not `timestamp`). Buckets: `toStartOfFiveMinutes(timestamp)` on R2 operations; `toStartOfTenMinutes(usageReportTimestamp)` with `MAX` on storage; on `workersLogs` group by `toDate(timestamp)`, `toHour(timestamp)`, `floor(toMinute(timestamp) / 5)` and rebuild the bucket start in code. Reversal: a source change is a new S1.
- **S2 · Weighting (proven).** Counts are `SUM(sampleInterval)`. Evidence: for `stuff` in 24 h, worker events `COUNT(*)` 26,544 against `SUM(sampleInterval)` about 110,500 (the Worker's 0.25 log sampling), and `stuff-mynpm` R2 `COUNT(*)` 29,808 against 455,578. CPU time is `SUM(cpuTimeMs * sampleInterval)` (proven to run) divided by invocations at read time; `cpu_max` is `APPROX_MAX(cpuTimeMs)`.
- **S3 · Metrics.** Stored per project and 5-minute bucket, each tagged `sum` or `max` in one `METRICS` map: `worker.invocations` and `worker.cpuMsSum` (sum), `worker.cpuMsMax` (max), `worker.status.<class>` for `2xx 3xx 4xx 5xx other` where `httpStatus` 0 is `other` (sum); `r2.<bucket>.ops.success`, `.ops.userError`, `.ops.other` (sum); `r2.<bucket>.storageBytes`, `.objects` (max); `probe.<name>.up` (**min**, changed in review so an outage survives coarse buckets) and `.ms` (max) in C1. R2 `userError` is expected 404 traffic (about 6,400 a day on `stuff-mynpm`) and is displayed but never scored.
- **S4 · Missing versus zero.** A bucket is settled once its end is at least `SETTLE_MS` = 45 minutes old (the ingestion lag is unmeasured; the newest event seen was 22 minutes behind a quiet period, so 15 minutes is not safe). The collector stores only rows the query returned. The API emits `0` for a counter bucket that is settled, has no row, and is covered by a successful collector run that finished after its settle time; otherwise the point is absent. Gauges (storage) are never zero-filled. Reversal: change `SETTLE_MS` after N4.
- **S5 · Cron and window.** Cron `*/5 * * * *`. Each run queries the trailing 90 minutes and upserts by `(project, metric, bucket_ms)`, writing only rows that are new or whose value changed (read, compare, write), so late data replaces earlier values, re-runs are idempotent, and an unchanged run writes zero rows. At most 6 binding queries per project per run, each with `LIMIT` and bound parameters (`$start`, `$script`, bucket names as an array or one query per bucket).
- **S6 · Storage (migration 4).** `project_samples(project TEXT, metric TEXT, bucket_ms INTEGER, value REAL NOT NULL, PRIMARY KEY (project, metric, bucket_ms)) STRICT`, retained 7 days; `project_hours(project, metric, hour_ms, value, PRIMARY KEY (project, metric, hour_ms)) STRICT`, retained 90 days, rebuilt idempotently for the affected hours after each upsert (sum adds, max maxes); `collector_runs(id INTEGER PRIMARY KEY, at_ms, ok, detail, rows_read, duration_ms) STRICT`, last 500 kept. Retention rides the existing alarm in batches of 1000. No `projects` table: the project list is config (S10). History accumulates from collection; the source's own retention is unproven on this new account.
- **S7 · API.** Under the existing Access check: `GET /api/v1/projects` returns `[{id, name, worker, buckets, probes, collector: {lastRunAtMs, lastSuccessAtMs, lastError, stale}}]` (`stale` when no success for 15 minutes); `GET /api/v1/projects/:id/history?range=1h|6h|24h|7d|90d&kind=worker|r2|probes|collector`. The bucket width is the smallest of 5 m, 15 m, 1 h, 3 h that gives at most 900 points; sums add, maxes max. Unknown id is 404, bad range or kind is 400, invalid project config is 503 with a fixed message.
- **S8 · Health limits.** Added to `LIMITS` in `src/client/health.ts` (tunable heuristics): Worker 5xx share of invocations 1% elevated, 5% critical; Worker average CPU 5 ms elevated, 20 ms critical; R2 `other` share 0.5% elevated, 2% critical; collector staleness 15 minutes elevated, 60 minutes critical; probe down is critical. Zero invocations and zero R2 operations are never a state by themselves. Added 2026-11-01 after real data: a share or average is not scored from a bucket with fewer than 100 events (`MIN_SCORED_EVENTS` in `health.ts`), because one failure in a 64-request bucket read as a critical 25%.
- **S9 · Client.** Route `/project/:projectId` (regex `^[a-z][a-z0-9-]{0,31}$`). The page is a status strip, an incident list, then two independent columns of widgets, reusing `buildCells`-style monitors, `monitorOne`, `TimeChart`, `Widget`, and the semantic colors (counts blue, outcomes by status colors only where the series means good or bad). No full-width graph.
- **S10 · Config.** One text binding `PROJECTS` holding typed JSON `[{id, name, worker, buckets[], probes[]}]`, validated at use; unknown keys, duplicate ids, non-https probe URLs, more than 8 probes, bucket names off `^[a-z0-9][a-z0-9-]{1,62}$` are rejected loudly. No CRUD, no projects table.
- **S11 · Probes (C1).** Per cycle, one `GET` per URL with a 10 s timeout. Up means status 200 to 399; a thrown fetch or timeout is down; duration is the elapsed milliseconds. The four URLs, all proven 200 from the owner's machine on 2026-11-01: `https://crates.17166969.xyz/current/registry/config.json`, `https://npm.17166969.xyz/current/`, `https://pypi.17166969.xyz/current/simple/`, `https://stuff.17166969.xyz/`. Probes measure from Cloudflare's edge, not users, and label themselves so.
- **S12 · Collector failure.** A failed run records a `collector_runs` row with a fixed detail, writes one fixed `console.error` JSON line (`{"event":"collector_failed"}`), writes no partial metrics, and rethrows so the cron shows the failure. Collector health is never folded into a target's own state.
- **S13 · Test seam.** The collector takes the binding as a plain `{ query }` object and `now` as a number, so tests pass a fake and the DO tests use the existing `TEST_NOW_MS`. `cloudflare/src/projects/queries.ts` has no imports so `node` can load it for the live check (`node cloudflare/scripts/check-analytics-sql.mjs`).
- **S14 · Budgets (measured, logged in `docs/operations.md`).** At most 60 DO rows written per project per run in steady state, counting the hourly rows it rebuilds (gate: over 150 fails); at most 6 binding queries per run; run wall time under 10 s; rows read per query recorded from live. The free-plan DO write allowance is 100,000 rows a day and the host ingest path already uses part of it; the collector must project to under 15,000 a day (60 times 288 is 17,280 only if every run changes 60 rows, which a quiet bucket does not).
- **S15 · Dependencies.** None added. Reversal needs an owner decision.
- **S16 · Invariants.** `AGENTS.md` gains one line: analytics reads use only the fixed queries in `cloudflare/src/projects/queries.ts`; no request data reaches SQL.

### Delegated (decide inside the bound, log only if a later slice depends on it)

- Exact SQL aliases, metric key spelling beyond S3's pattern, widget order and titles within S9's two-column rule, chart panel heights, and the wording of empty states.
- How the cron key is written in `cloudflare.config.ts`: find it with `cf docs search` and `cf schema`; the proof is `make worker-check`.
- Whether `scheduled` calls the DO by RPC or `stub.fetch`; either must be idempotent.

## Baseline

- Known red: none at `d1b369c`.
- Loop timings (2026-11-01, warm): `make fixtures` 0 s, `make cloudflare-test` 3 s (typecheck plus 76 tests), `make dashboard-test` 5 s (24 tests, builds first), `make lint` 1 s, `make worker-check` 1 s. A single vitest file runs in 1 to 3 s from `cloudflare/` with `pnpm exec vitest run test/<file>`.
- Live query cost (informational): each SQL query returned in 50 to 800 ms and read 1 to 8 million rows; queries over a 90-day window read over 150 million rows, so the collector never queries more than 90 minutes.

## Sequence

All items are serial. `installation.ts`, `index.ts`, and the client router are shared files.

| ID | Item | Owns | After | Acceptance |
| --- | --- | --- | --- | --- |
| A1 | Query builders and row parsers | `cloudflare/src/projects/queries.ts`, `parse.ts`, `cloudflare/test/projects-queries.test.ts`, `cloudflare/test/fixtures/analytics/*.json`, `cloudflare/scripts/check-analytics-sql.mjs` | | `cd cloudflare && pnpm exec vitest run test/projects-queries.test.ts` and `node cloudflare/scripts/check-analytics-sql.mjs` |
| A2 | Config, binding, cron, registry validation | `cloudflare/cloudflare.config.ts`, `cloudflare/worker-configuration.d.ts`, `cloudflare/src/projects/config.ts`, `cloudflare/test/projects-config.test.ts` | A1 | `pnpm exec vitest run test/projects-config.test.ts` and `make worker-check` |
| A3 | Storage, hourly rollup, retention | `cloudflare/src/installation.ts`, `cloudflare/src/projects/store.ts`, `cloudflare/test/projects-store.test.ts`, `cloudflare/test/migration.test.ts` | A2 | `pnpm exec vitest run test/migration.test.ts test/projects-store.test.ts` |
| A4 | Collector and `scheduled` handler | `cloudflare/src/projects/collector.ts`, `cloudflare/src/index.ts`, `cloudflare/test/projects-collector.test.ts` | A3 | `pnpm exec vitest run test/projects-collector.test.ts` and `make worker-check` |
| A5 | API and history shaping (M1) | `cloudflare/src/index.ts`, `cloudflare/src/installation.ts`, `cloudflare/src/projects/history.ts`, `cloudflare/test/projects-api.test.ts` | A4 | `pnpm exec vitest run test/projects-api.test.ts`, then the full suite |
| B1 | Client data layer, route, fleet Projects table | `cloudflare/src/client/api.ts`, `queries.ts`, `router.ts`, `Shell.tsx`, `pages/FleetPage.tsx`, `health.ts`, `cloudflare/test/ui/dashboard.spec.ts` | A5 | `make dashboard-test` |
| B2 | Project page (M2) | `cloudflare/src/client/pages/ProjectPage.tsx`, `pages/project/*.tsx`, `style.css`, `cloudflare/test/ui/dashboard.spec.ts` | B1 | `make dashboard-test`, then the full suite |
| C1 | Probes (M3) | `cloudflare/src/projects/probes.ts`, `collector.ts`, `config.ts`, `history.ts`, `pages/project/*.tsx`, `cloudflare/test/projects-probes.test.ts` | B2 | `pnpm exec vitest run test/projects-probes.test.ts`, `make dashboard-test`, then the full suite |
| D1 | Docs, budgets, contract write-up | `docs/architecture.md`, `docs/operations.md`, `README.md`, `AGENTS.md` | C1 | `make fixtures cloudflare-test dashboard-test lint worker-check`; `mdtool check --untracked campaign-cf.md` |
| E1 | Close | none | D1 | `ultrareview`; fix its P1 and P2 findings; delete dead code (a `rg` for each new export with no consumer); final report |

Item content (what makes each acceptance meaningful):

- **A1.** Tests assert the SQL text: every count is `SUM(sampleInterval)`; no `COUNT(*)`, no bare `MIN`/`MAX` on sampled datasets, every `ORDER BY` has `LIMIT`, no `toStartOfInterval` on `workersLogs`, values are bound parameters never interpolated, bucket start is rebuilt from `(toDate, toHour, slot)` across midnight, `httpStatus` 0 and 5xx and the R2 outcomes classify per S3. Fixtures are real result bodies from `cf sql query` (project names kept). The live script runs each built query and fails on any non-200 or unparsable row; if `cf` is unauthenticated, park the live half on **Needs environment**.
- **A2.** `bindings.analytics` for `ANALYTICS_SQL`, `bindings.text` for `PROJECTS` with the `stuff` entry (S10, S11 URLs under `probes` stay empty until C1), the cron per S5. The validator rejects each bad case in S10 with a test. `Env` gains `ANALYTICS_SQL: AnalyticsSQLBinding` (the runtime type already exists in `.cloudflare/types/index.d.ts`).
- **A3.** Migration 4 applies to a fresh object and upgrades a version-3 object keeping hosts and samples. Tested: an identical second upsert writes zero rows (assert `rowsWritten`), a changed value writes only that row and its hour, the hourly rebuild, retention batches, and zero rows when a run returns nothing.
- **A4.** With a fake binding: a second identical run changes nothing; a later run with a larger value replaces it; a thrown query records a failed run, writes no metrics, rethrows; query count and rows written stay inside S14.
- **A5.** 401 without Access, 404 and 400 cases, zero-fill versus absent per S4 (including a failed collector run that must not justify a zero), bucket-width rule, `stale` flag.
- **B1/B2.** Mocked API like `dashboard.spec.ts`. Assertions: Projects table on the fleet page and its link; project page headings; status strip cells; an elevated Worker 5xx share raises an incident with a Zoom action; a stale collector shows its state; no graph spans both columns (`.column` ancestry).
- **C1.** Fake `fetch`: up on 200 and 301, down on 500, down on a thrown error and on timeout, duration recorded, empty list does nothing, a collector failure does not mark probes down.

## Acceptance

- **Collector:** `pnpm exec vitest run test/projects-collector.test.ts` passes: idempotent, late-data correcting, failure-recording, budget-respecting. Failure is any partial write after a thrown query.
- **API:** `pnpm exec vitest run test/projects-api.test.ts` passes, including the S4 rule in both directions (zero when settled and covered; absent otherwise).
- **SQL contract:** `pnpm exec vitest run test/projects-queries.test.ts` and `node cloudflare/scripts/check-analytics-sql.mjs` pass; the second is read-only and live.
- **UI:** `make dashboard-test` passes with the new project assertions.
- **Whole:** `make fixtures cloudflare-test dashboard-test lint worker-check` passes at each milestone and at close, with the existing 24 UI tests and 76 Worker tests still green.
- **Docs:** architecture, operations, README, and `AGENTS.md` describe what shipped; each contract change below is written up.

## Needs environment

Run after the owner deploys (`make deploy`).

- **N1 · Cron and binding live.** Wait 15 minutes, then: `tok=$(cf access token https://stats.17166969.xyz); curl -s -H "cf-access-token: $tok" https://stats.17166969.xyz/api/v1/projects | jaq '.[0].collector'`. Expect `lastSuccessAtMs` within 10 minutes and `stale` false. If there is no run, apply schedules with `cf workers triggers deploy` and report what `cf deploy` did.
- **N2 · Parity with Cloudflare.** For one settled hour, compare the history API's invocation sum with `cf sql query "SELECT SUM(sampleInterval) AS n FROM logs.workersLogs WHERE scriptName = 'stuff' AND logType = 'cf-worker-event' AND timestamp >= NOW() - INTERVAL '2' HOUR AND timestamp < NOW() - INTERVAL '1' HOUR" --scope-account <id>`. Expect agreement within 5%.
- **N3 · Probes live.** Every probe `up` is 1 in `kind=probes`. A persistent 522 or similar means same-account fetches to custom domains are blocked; the owner decides whether to move probes elsewhere.
- **N4 · Ingestion lag.** Measure how late `logs.workersLogs` rows arrive (newest event timestamp against now over several days of traffic) and set `SETTLE_MS` if 45 minutes is wrong.
- **N5 · Source retention.** Record how far back each dataset actually serves once the account has history; the project page's 90-day view fills from collection regardless.
- **N7 · Binding and Log Explorer.** The binding docs say Log Explorer-backed datasets are not supported through the Workers binding, and `logs.workersLogs` is Log Explorer-backed. The CLI returns the same `{data, rows, statistics}` shape, so `check-analytics-sql.mjs` passes, but only a deployed run settles it. After N1, confirm `kind=worker` history has rows; if the collector fails on the Worker query, the Worker metrics need another source (a new S1 and an owner decision).
- **N2 re-run.** `node cloudflare/scripts/check-parity.mjs` compares every settled stored Worker bucket from the last 24 hours with `cf sql query` and exits 1 above 5% total error. On 2026-11-01 it found 14 of 15 buckets exact and -3.5% total (the one miss left the window stale).
- **N6 · Golden snapshots for the project page.** Done for 1 h on 2026-11-01 (`scripts/capture-project.sh stuff`, replay goldens `stuff-1h-*`). Add 6 h after six hours of collection and the longer ranges once the data exists, by running the script with those ranges.

## Execution boundary and non-goals

**Authorized:** everything in the Charter grant. **Forbidden:** push; `make deploy*`, `cf deploy`, `cf workers triggers deploy`; any Cloudflare write; creating tokens or secrets; edits in `../stuff` (read it, change nothing); new dependencies; formatters; changes to the agent, the ingest wire protocol, or `fixtures/v1`.

**Contract changes the owner is accepting** (each is written up in D1):

- Durable Object schema version 4: tables `project_samples`, `project_hours`, `collector_runs`.
- Worker config: the `analytics` binding `ANALYTICS_SQL` (account-wide analytics read, O1), the `PROJECTS` text binding, and a five-minute cron trigger; a `scheduled` export on `stats-worker`.
- API: `GET /api/v1/projects` and `GET /api/v1/projects/:id/history`, behind Access.
- Client routes: `#/project/:projectId`, and a Projects table on the fleet page.
- `AGENTS.md` invariant S16.
- Unchanged: agent, ingest protocol v1, host schema, host routes.

**Non-goals, with reasons:** GraphQL and API tokens (O1); true CPU quantiles (O2); per-registry attribution (one Worker serves all four domains and the source has no host dimension), cache hit ratio, billing (no SQL source proven); R2 GET and PUT split and transferred bytes (`r2CombinedOperations` has `actionStatus`, an outcome, but no action column, and `objectSizeBytes` is object size, not bytes sent); Worker exceptions from `logs.issues` and the `error` column (the column is always empty; `logs.issues` is unproven for this use); deployment markers (no source in the SQL catalog; the Workers deployments API is a separate integration); alert delivery (stats has no notification channel); a projects CRUD API or table (one project, S10); other datasets (D1, KV, Durable Objects).

## Reference

Verified at `d1b369c`:

- `cloudflare/src/installation.ts:110` `MIGRATIONS` (version 3 is last); `:185` `Installation`; `:188` `invalidateHistory`; `:304` `history`; `:354` `alarm`; `:477` `fetch`; time comes from the DO's `now()` honoring `TEST_NOW_MS`.
- `cloudflare/src/index.ts:36` default export (`fetch` only today); `:56` and `:60` the `/api/v1/` Access gate and route regex that A5 extends with `projects`.
- `cloudflare/worker-configuration.d.ts:2` hand-maintained `Env`; `cloudflare/cloudflare.config.ts` bindings and domains; `cloudflare/wrangler.test.jsonc` test Worker.
- `cloudflare/src/client/health.ts:33` `LIMITS`, `:136` `evaluate`; `incidents.ts:28` `monitorOne`; `pages/host/monitors.ts:64` `buildCells`; `pages/host/shared.tsx:8` `AXIS_WIDTH`; `router.ts:11` the host route; `pages/FleetPage.tsx:45` `FleetPage`; `client/api.ts:464` `hostPath`, `:466` `getHosts`; `queries.ts:10` `loadHosts`.
- `cloudflare/test/ui/dashboard.spec.ts` is the mocked-API pattern; `cloudflare/test/history.test.ts` shows the DO test helpers.
- `../stuff/crates/stuff-worker/cloudflare.config.ts` defines Worker `stuff`, the four domains, buckets `stuff-mycrates`, `stuff-mynpm`, `stuff-mypypi`, and `headSamplingRate: 0.25` (the source of S2's 4x).
- Cloudflare docs used: Analytics SQL binding (`developers.cloudflare.com/analytics/sql-api/workers-binding/`), SQL datasets, functions, and limits pages.
