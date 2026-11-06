Prefix: STA
Next: 77

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
- **Recommendation:** Read the stored `project_hours` values for the affected hours in one query and compute the hour aggregates in one grouped query, then write only the changed rows. Compare `jsrpc` CPU from the same dataset before and after.
- **Fix with:** make-it-fast
- **Effort:** S

### STA-33 · P3 · Ingest CPU tail of 35 to 47 ms is unexplained

- **Area:** Performance
- **Where:** `cloudflare/src/core/installation/installation.ts:479` (`ingest`)
- **Problem:** The slowest HTTP calls with 49-byte (ingest) responses took 33 to 47 ms of CPU on 2026-11-01, against 5.3 ms for the average HTTP call. A Node microbenchmark of the pure-JS phases on the v1 `batch-full.json` fixture (now `bench/legacy-v1/`) came to about 0.8 ms per ingest, 0.64 ms of it the hour rebuild, so the tail is not JS. SQLite work or a cold wake is the suspect. Unproven.
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

### STA-45 · P3 · Report each deployment's observed impact without being asked

- **Area:** Observability
- **Where:** `cloudflare/src/observe/client/cli.ts`, `cloudflare/src/observe/core/store.ts` (`rolloutImpact`)
- **Problem:** Whether a deploy brought new issue groups, regressions, a higher failure rate, or more CPU is answered only when someone runs `pnpm observe deployment <rollout>` or opens the deployment card. The Phase 5 review was this check done by hand, a day late, from sampled logs.
- **Recommendation:** A scheduled job, a cron agent or a host timer, that reads `pnpm observe issues --json` and `pnpm observe deployment <newest rollout> --json` for each observed service a few hours after each rollout, and files a ticket or posts a note only when there is a new issue, a regression, or a CPU or failure-rate change larger than the reported spread. It reports and proposes; it never pushes or deploys. Alert delivery is a campaign non-goal, so the destination and whether to build it at all are owner decisions.
- **Fix with:** none
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

### STA-38 · P4 · Review the redesigned goldens and the live dashboard

- **Area:** Tests
- **Where:** `cloudflare/test/ui/replay.spec.ts-snapshots/`
- **Problem:** The 2026-11-01 dashboard rewrite regenerated 16 golden images with `--update-snapshots`. Only the threadripper 1 h charts and tiles and the stuff 1 h charts and tiles were looked at, and only on desktop for stuff. The 24 h and 7 d goldens, the mobile stuff pages, and the deployed page were not.
- **Recommendation:** Open each remaining golden and the deployed `#/project/stats` and `#/host/...` pages, and file or fix anything that reads wrong.
- **Deferred (owner, 2026-11-05).**
- **Fix with:** none
- **Effort:** S

### STA-39 · P4 · Add the 6h project goldens

- **Area:** Tests
- **Where:** `cloudflare/test/ui/captures/stuff/`, `cloudflare/test/ui/replay.spec.ts:70`
- **Problem:** The project replay covers only the 1h range. Six hours of data exist only after 2026-11-02 01:20 UTC, because history restarted at 2026-11-01 19:20 UTC.
- **Recommendation:** After that time run `cloudflare/scripts/capture-project.sh` for the 6h range, add a 6h replay test, and regenerate the golden images.
- **Fix with:** none
- **Effort:** S

### STA-40 · P4 · The capture script omits the route and Durable Object kinds

- **Area:** Tests
- **Where:** `cloudflare/scripts/capture-project.sh:25`
- **Problem:** The loop fetches `worker r2 probes collector` only. `captures/stuff/routes-1h.json` was assembled by hand from a live `cf sql query` run through `parseRouteRows`, so the next capture will not reproduce it and the replay breaks.
- **Recommendation:** Add `routes` and `durable-objects` to the loop, make the replay serve `durable-objects` captures for projects that have namespaces, and replace the hand-built file with a real capture.
- **Status (2026-11-05):** the capture script now captures `routes` and `durable-objects` for every requested range. Left: replace the hand-built `test/ui/captures/stuff/routes-1h.json` with a real production capture.
- **Fix with:** none
- **Effort:** S

### STA-49 · P4 · Nanoshop does not check its routes and operations against Stats' lists

- **Area:** Operability
- **Where:** `cloudflare/src/observe/core/nanoshop-policy.ts` (`NANOSHOP_ROUTES`, `NANOSHOP_RPC_METHODS`, `NANOSHOP_OPERATIONS`); Nanoshop's `src/routes/routes.ts` and `src/cloudflare/observe/operations.ts`
- **Problem:** Stats generates its matcher and operation set from exported data, but the data is copied by hand from Nanoshop. Nothing fails when Nanoshop adds a route or an error operation: the new route is excluded and the new operation is rejected, losing data silently.
- **Recommendation:** In Nanoshop's Stats integration tests, compare its `ROUTES` patterns and `ErrorOperation` set with the exported Stats lists.
- **Fix with:** single-source-of-truth
- **Effort:** S

