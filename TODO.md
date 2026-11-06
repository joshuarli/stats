Prefix: STA
Next: 84

### STA-50 · P2 · Overlapping RPCs on one Durable Object lose their trace marks

- **Area:** Observability
- **Where:** `cloudflare/src/observe/cloudflare/tail.ts` (`readChannel`), `docs/architecture.md` (Sampling relies on each invocation's tail event)
- **Problem:** In local workerd, when RPCs overlap on one Durable Object instance, diagnostics-channel messages land on other invocations' tail events: five at a time produced events with zero to four messages. An object event with no message is untraced, so a sampled service always keeps it. An event with one invocation mark keeps only its own span's operation message and counts a stray one's publisher with no summary. An event with marks of two different spans is ambiguous: it is kept untraced with no summary and counted in health as `rejected` `ambiguous_invocation_mark`. One with no mark and two operation messages is rejected as `rejected-invalid`. Nanoshop's one `TenantStore` object per shop is exactly this shape. Production is unmeasured.
- **Recommendation:** Measure the share of untraced and rejected object events once Nanoshop runs locally under load. If it is high, find a mark that does not travel by diagnostics channel, or sample object events by a key that does not need the trace.
- **Fix with:** none
- **Effort:** M

### STA-51 · P2 · Two production behaviors that sampling relies on are unverified

- **Area:** Observability
- **Where:** `cloudflare/src/observe/cloudflare/store-object.ts` (`samplingOf`), `cloudflare/src/observe/cloudflare/worker.ts` (`tail`)
- **Problem:** The store reads its service from `ctx.id.name`, which local workerd sets in the constructor and in an alarm after a restart. Production is unchecked, and an unnamed object makes every observe call for that service throw. The idle flush holds a timer in `ctx.waitUntil` for 20 s, inside the 30 s documented for HTTP-triggered Workers, which the tail handler is not; whether a tail isolate lives long enough between batches for its buffer to flush is unchecked.
- **Status (2026-11-06):** no sampled deploy exists. `GET /api/observe/stats/health` has no `sampling` field, so `stats` is observed unsampled, `statsctl health --project nanoshop-storied` answers `not_observed: only stats is observed`, and `nanoshop-storied` has no deployments recorded. The first behavior holds for the `stats` object: `policyOf` throws on an unnamed object and `ingest`, `explore` and `health` call it on every request, yet production accepted 37,125 of 37,751 ingest batches and answered `statsctl observe routes --project stats` and the health read. The alarm's `cleanup` does not read the policy. The second behavior, the 20 s idle flush in the tail handler, cannot be observed until a sampled service runs; `flushes` is 0 on `nanoshop-storied`.
- **Recommendation:** Before the first sampled deploy, read `GET /api/observe/stats/health` and `statsctl observe routes --project stats` after the deploy, and watch `flushes` in a sampled service's health. If an object is unnamed, pass the service on each call; if the timer is cut short, drop it and accept that an idle isolate flushes on its next event.
- **Fix with:** none
- **Effort:** S

### STA-31 · P3 · Collector store write still costs about 26 ms of Durable Object CPU per run

- **Area:** Performance
- **Where:** `cloudflare/src/projects/store.ts:57`, `cloudflare/src/projects/store.ts:101`
- **Problem:** `events.durableObjectsInvocations` shows the cron's store write (`invocationType = 'jsrpc'`) at 19 to 37 ms per run before 2026-11-01 20:30, and 22 to 28 ms for the four runs after `edfeea3` replaced the per-point SELECT with one range read. The route and Durable Object metrics added about 80 points per project in the same window, so the change probably absorbed that cost rather than cutting the old one. `rebuildHour` still runs two SELECTs and an INSERT for every changed metric and hour. Unproven: which of the two dominates.
- **Status (2026-11-06):** read from production, observational only (no before and after pair, so no speedup is claimed). `Installation.recordCollectorRun` object invocations in the 618 scheduled traces from 2026-11-04 01:00Z to 2026-11-06 05:00Z (617 with one such call): CPU median 26 ms, p90 45, p99 66, max 99, mean 28.3, wall median 192 ms. By day the median is 22 ms (272 runs), 27 ms (286) and 37 ms (59, partial day, p90 64), so the cost is rising, not flat. Slowest tenth of runs 58.2 ms against 11.1 ms for the fastest tenth; the upstream rows the run read explain little of it (correlation 0.13, 285 runs). `statsctl observe operations --project stats --window 24h` reports `collector.record` as 282 runs, 9,137 ms CPU, 1,264,467 rows read, 61,342 rows written and 78,813 statements, which is 4,484 rows read, 217 rows written and 279 statements per run. With one INSERT per changed point and a SELECT, SELECT and INSERT per changed metric and hour, 279 statements and 217 rows written solve to about 186 sample INSERTs and 31 rebuilt hours, so the per-point INSERTs are about two thirds of the statements and the two SELECTs per hour about a fifth. That estimate assumes the few other statements per run are negligible and that CPU follows statement count, which is unproven; batching only the hour rebuild, as recommended below, would reach the smaller share. Next step: a local run of `upsertPoints` with the production point and hour counts, timing the sample INSERT loop against the hour rebuild, before choosing.
- **Recommendation:** Read the stored `project_hours` values for the affected hours in one query and compute the hour aggregates in one grouped query, then write only the changed rows. Compare `jsrpc` CPU from the same dataset before and after.
- **Fix with:** make-it-fast
- **Effort:** S

### STA-33 · P3 · Ingest CPU tail of 35 to 47 ms is unexplained

- **Area:** Performance
- **Where:** `cloudflare/src/core/installation/installation.ts:479` (`ingest`)
- **Problem:** The slowest HTTP calls with 49-byte (ingest) responses took 33 to 47 ms of CPU on 2026-11-01, against 5.3 ms for the average HTTP call. A Node microbenchmark of the pure-JS phases on the v1 `batch-full.json` fixture (now `bench/legacy-v1/`) came to about 0.8 ms per ingest, 0.64 ms of it the hour rebuild, so the tail is not JS. SQLite work or a cold wake is the suspect. Unproven.
- **Status (2026-11-06):** the tail is smaller now and is CPU, not waiting. From 36 random five-minute windows in the last 23 hours, 1,078 ingest traces (about 9% of the roughly 11,500 calls, none of the windows truncated), Worker plus Durable Object CPU is median 5 ms, p90 10, p95 14, p99 20, max 33; the 2026-11-01 range of 33 to 47 ms was a maximum over a whole day, so the two maxima are not comparable. The slowest 5% (65 traces, mean 17.0 ms CPU) against the faster half (580 traces, mean 4.1 ms): Durable Object wall 48.6 ms against 35.2 ms and request wall 90.8 ms against 61.9 ms. Wall minus CPU is 31.6 ms against 31.1 ms, so the extra wall is the extra CPU and there is no extra waiting or cold wake. CPU does not vary by version (medians 4 to 6 ms across seven versions) or by minute within the cron's five minutes (median 5 to 6 ms). `statsctl observe operations --project stats --window 24h` gives `host.ingest` at 8,653 calls, 6.2 ms mean CPU, 16.5 rows written, 49.1 rows read and 18.6 statements per call. The ticket's comparison cannot be done: traces carry no SQLite statement spans, only per-operation totals, so the statements and rows of a slow call are unknown. Sorting traces by wall (`order=slowest`) finds waiting, not CPU: the 50 slowest by wall have median CPU 6 ms, the same as all calls.
- **Recommendation:** Compare the SQLite statement spans (query, rows read and written) of slow and fast ingest traces, now that the Worker samples traces, and compare their wall time against CPU. Do not move the hour rebuild until that shows it matters, because deferring it changes how fresh the 30-day charts are.
- **Fix with:** make-it-fast
- **Effort:** M

### STA-44 · P3 · One observed invocation was dropped as a key conflict

- **Area:** Observability
- **Where:** `cloudflare/src/observe/core/store.ts:339`, `cloudflare/src/observe/core/model.ts:100`
- **Problem:** On 2026-11-04 `stats-observe` health reported `conflict: 1` against 8,388 stored invocations: an event arrived with the key of a stored invocation but different content, and the store kept the first and dropped the second. The key is the published span ID, or for an invocation without one, a hash of version, object, kind, label, and event millisecond. Every stats entry point publishes a mark, so a missing span is unexpected. Unproven: whether the platform reused a span ID, an invocation ran without an active span and collided with a same-millisecond twin, or classic tail redelivered an event with changed content.
- **Recommendation:** Health now records each conflict's key source (`span` or `fallback`) with an example naming the invocation and the stored columns that differ; the one conflict from before is reported as `unrecorded`. Read `pnpm observe health` after a week. If fallback collisions dominate, add a field that separates same-millisecond invocations to the key; if span reuse does, key on trace and span together; if only `errors` differ, look at redelivery.
- **Status (2026-11-06):** `GET /api/observe/stats/health` shows `conflict: 1` with reason `unrecorded` and no example, against 46,034 live invocations from 2026-11-04 to 2026-11-06, `duplicate: 0` and `rejected: 0`. No conflict has arrived since key sources were recorded, so there is nothing to decide yet. Read again after a week of recorded data.
- **Fix with:** root-cause
- **Effort:** S

### STA-53 · P3 · A failed collector run cannot be traced to its Analytics query

- **Area:** Projects
- **Where:** `cloudflare/src/cloudflare/projects/collector.ts:53` (`run`), `:70` (`collector_failed`), the stats `scheduled` handler
- **Problem:** Read from stats-observe traces, collector history and `events.durableObjectsInvocations` on 2026-11-06, over 2026-11-04 01:00Z to 2026-11-06 05:00Z (618 recorded scheduled invocations, 620 five-minute slots). Missing runs are Cloudflare's: the 09:35Z and 09:40Z crons on 2026-11-05 never started (no scheduled tail event, no Durable Object `jsrpc` in their buckets, while ingest traces continued every minute), and the 09:30Z cron started at 10:31:36Z, 61 minutes late, and recorded its run with `atMs` 09:30:48Z. That is 3 slots in 620 with no on-time run, in one 15 minute event. The failed runs are ours to explain but not yet explainable: 8 of 618 (1.3%) ended `exception`, and all 8 are an uncaught `AnalyticsSQLAPIError` thrown by `input.analytics.query` in `run` (`collector.ts:53`, awaited through `Promise.all` at `:57`). The 10:05Z run that read 32,064,861 rows in 5.2 s is one of them; the four failures in the 24 hour collector history read 44.0M, 15.7M, 32.1M and 31.6M rows against a median of 46M, so they do not follow row count, and two failed in under 0.5 s. The observe occurrence has no message, `collector_failed` carries no detail, and the run record does not store which query was in flight, so which of the per-project queries failed and with which status is unknown.
- **Recommendation:** Record the failing query kind and the Analytics error status in the failed run's `detail` and in the `collector_failed` log line, then read the next few failures. If they are 429 or 5xx from the Analytics API, retry that one query once inside the run and document the rate; if one query kind fails, fix that query.
- **Fix with:** root-cause
- **Effort:** S

### STA-76 · P3 · Every collector run fails a deployment poll for a Worker that does not exist

- **Area:** Projects
- **Where:** `cloudflare/cloudflare.config.ts:55` (`nanoshop-storied` project), `cloudflare/src/cloudflare/deployments/collector.ts:63` (`request`), `cloudflare/src/cloudflare/index.ts` (`scheduled`)
- **Problem:** `cf workers deployments list --script-name nanoshop-storied` answers `[10007] This Worker does not exist on your account` (404), so the deployment poll for that project throws `Error("upstream")` in `request` on every cron. `reportError("deployments.poll", ...)` records it as a caught error: 156 occurrences since 2026-11-05 13:20Z in one open issue, and the trace of every scheduled run has `errorCount` 1 and `failed: true`. `statsctl observe routes --project stats --window 1h` lists `scheduled */5 * * * *` as 12 requests, 12 failed, and `statsctl health --project nanoshop-storied` reports `sync_never_succeeded` and `sync_error: upstream`. A real scheduled failure (STA-53) is indistinguishable from this in the failure rate.
- **Recommendation:** Owner decision: remove `nanoshop-storied` from the project list until its Worker is deployed, or make the poll record a 404 as "worker not deployed" without reporting an error. Then confirm the scheduled failure rate falls to the real exceptions.
- **Fix with:** none
- **Effort:** S

### STA-77 · P4 · Rollouts have no CI write path

- **Area:** Operability
- **Where:** `cloudflare/src/observe/http/api.ts` (`POST /rollouts`), `cloudflare/src/cloudflare/index.ts` (observe proxy), `docs/observe.md`
- **Problem:** The stats proxy refuses rollout writes on purpose, so only the Cloudflare deployment poll records rollouts. A service deployed outside Cloudflare, or a deploy a CI job wants to record before the poll sees it, has no authenticated way to write one. Choosing the surface is an owner decision: an Access service token on a separate route, or a write token on a future public receiver.
- **Recommendation:** Decide the surface when a non-Cloudflare producer exists. Service deploy markers (`POST /ingest/services/:name/deployments`) already give servers a token-authenticated write; reuse that shape if the decision is to extend it to observed services.
- **Fix with:** architect
- **Effort:** M

### STA-38 · P4 · Review the redesigned goldens and the live dashboard

- **Area:** Tests
- **Where:** `cloudflare/test/ui/replay.spec.ts-snapshots/`
- **Problem:** The 2026-11-01 dashboard rewrite regenerated 16 golden images with `--update-snapshots`. Only the threadripper 1 h charts and tiles and the stuff 1 h charts and tiles were looked at, and only on desktop for stuff. The 24 h and 7 d goldens, the mobile stuff pages, and the deployed page were not.
- **Recommendation:** Open each remaining golden and the deployed `#/project/stats` and `#/host/...` pages, and file or fix anything that reads wrong.
- **Deferred (owner, 2026-11-05).**
- **Fix with:** none
- **Effort:** S

### STA-49 · P4 · Nanoshop does not check its routes and operations against Stats' lists

- **Area:** Operability
- **Where:** `cloudflare/src/observe/core/nanoshop-policy.ts` (`NANOSHOP_ROUTES`, `NANOSHOP_RPC_METHODS`, `NANOSHOP_OPERATIONS`); Nanoshop's `src/routes/routes.ts` and `src/cloudflare/observe/operations.ts`
- **Problem:** Stats generates its matcher and operation set from exported data, but the data is copied by hand from Nanoshop. Nothing fails when Nanoshop adds a route or an error operation: the new route is excluded and the new operation is rejected, losing data silently.
- **Recommendation:** In Nanoshop's Stats integration tests, compare its `ROUTES` patterns and `ErrorOperation` set with the exported Stats lists.
- **Fix with:** single-source-of-truth
- **Effort:** S

### STA-78 · P4 · The stuff site probe reported down once in its first runs

- **Area:** Projects
- **Where:** `cloudflare/cloudflare.config.ts:19` (the `site` probe), `docs/operations.md` (Verified environments)
- **Problem:** On 2026-11-01 the `site` probe of `stuff` was down in one of the first five collector runs and returned 200 on every later check. Probes measure from Cloudflare's edge and a failed fetch records down, so a cold-start or edge blip reads as an outage. Whether it recurs is unknown.
- **Recommendation:** Read `kind=probes` history for `stuff` over 7 days. If `site` shows isolated single-bucket downs, decide between keeping the signal as is and requiring two consecutive failures before it scores; if it shows none, delete this ticket.
- **Fix with:** none
- **Effort:** S

### STA-79 · P4 · The 45 minute settle time rests on one day of ingestion-lag samples

- **Area:** Projects
- **Where:** `cloudflare/src/limits.ts:11` (`PROJECT_SETTLE_MS`), `docs/operations.md` (Verified environments)
- **Problem:** `PROJECT_SETTLE_MS` decides when a missing counter bucket reads as zero. It was set from 2026-11-01 readings only: the newest Worker event was 6.7 minutes old under steady traffic and 22 minutes old in a quiet period. Too short a settle time writes zeros that late rows would have filled, too long delays charts and verdicts. A parity re-run on 2026-11-06 found one bucket (11:10 on 2026-11-05) that stored 44 events against 8 from the source, which the lag explanation does not cover.
- **Recommendation:** Measure the newest-event age against now over several days of traffic, including quiet nights, and change `PROJECT_SETTLE_MS` only if the 99th percentile approaches it. Investigate the 11:10 bucket with `node cloudflare/scripts/check-parity.mjs`.
- **Fix with:** root-cause
- **Effort:** S

### STA-80 · P4 · The projects page on the Node target points at a Cloudflare config file

- **Area:** Docs
- **Where:** `cloudflare/src/client/pages/ProjectsPage.tsx:43`
- **Problem:** The Node server has no project collector, so its project registry is always empty and the page shows "Projects are declared in cloudflare/cloudflare.config.ts." That tells a Node user to edit a file that has no effect on their instance.
- **Recommendation:** Show an empty-state detail that says the target has no project collector when the server reports an empty registry on the Node target, and keep the current text for Cloudflare.
- **Fix with:** none
- **Effort:** S

### STA-81 · P3 · A leaked service deploy token cannot be rotated or revoked

- **Area:** Security
- **Where:** `cloudflare/src/core/installation/services.ts`, `docs/architecture.md` (Services and deploy markers)
- **Problem:** The deploy token is shown once at service creation and stored as a SHA-256 verifier. No route rotates or revokes it, unlike host tokens. The token is accepted from any network on `/ingest/services/:name/deployments` and writes markers that appear on the service's timeline and feed `statsctl verify --service`, so a leaked token lets a third party forge deploys until the service is deleted, and there is no delete route either.
- **Recommendation:** Add `POST /api/v1/admin/services/:name/rotate`, which returns a new token once and invalidates the old verifier, mirroring host rotation, with a test that the old token gets 401 after rotation.
- **Fix with:** security
- **Effort:** S

### STA-82 · P4 · Service cgroup I/O may count one I/O twice on stacked devices

- **Area:** Data
- **Where:** `agent/src/cgroup.rs:61` (`parse_io_stat`), `docs/protocol.md` (services group)
- **Problem:** The agent sums `rbytes`, `wbytes`, `rios`, and `wios` over every device `io.stat` lists. On a host where a unit's I/O goes through a device-mapper or md device, the same bytes can be listed for the virtual device and for its backing devices, so `service.io` overstates throughput. It has not been measured on such a host.
- **Recommendation:** Read `io.stat` on a host with stacked storage and compare the per-device lines with `iostat`. If devices double count, sum only devices that are not holders of another listed device, and add a fixture for it.
- **Fix with:** none
- **Effort:** M

### STA-83 · P4 · The offline local stack has no Linux network sandbox

- **Area:** Tests
- **Where:** `scripts/offline-run.sh`, `Makefile:189` (`OFFLINE_SANDBOX_CHECK`), `docs/testing.md` (Local stack)
- **Problem:** `scripts/offline-run.sh` exits 2 off macOS, so `make check` runs `make integration-local` only on Darwin. On Linux the stack still fails any undeclared outbound Worker request and removes `CLOUDFLARE_*` and `CF_*`, but nothing denies network to the browser or to `statsctl`, so a Linux run proves less than the macOS one. No Linux host was available to verify an alternative.
- **Recommendation:** On a Linux host, run the same commands under `unshare -rn` with a loopback interface brought up, confirm Chromium launches under it, add that branch to `scripts/offline-run.sh`, and drop the Darwin-only condition from `OFFLINE_SANDBOX_CHECK` if it passes.
- **Fix with:** none
- **Effort:** M
