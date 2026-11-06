Prefix: STA
Next: 76

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

### STA-36 · P3 · Re-run the Worker parity check after a day of data

- **Area:** Tests
- **Where:** `cloudflare/scripts/check-parity.mjs`, `docs/operations.md:80`
- **Problem:** Stored history restarted at 2026-11-01 19:20 UTC after the Worker rename, so the 24 hour comparison of stored buckets against `cf sql query` has no full day to compare yet.
- **Recommendation:** On or after 2026-11-02 19:20 UTC run `node cloudflare/scripts/check-parity.mjs` (needs `cf access login`). If it fails above 5% total error, record why in `docs/operations.md` next to the existing miss.
- **Fix with:** none
- **Effort:** S

### STA-44 · P3 · One observed invocation was dropped as a key conflict

- **Area:** Observability
- **Where:** `cloudflare/src/observe/core/store.ts:339`, `cloudflare/src/observe/core/model.ts:100`
- **Problem:** On 2026-11-04 `stats-observe` health reported `conflict: 1` against 8,388 stored invocations: an event arrived with the key of a stored invocation but different content, and the store kept the first and dropped the second. The key is the published span ID, or for an invocation without one, a hash of version, object, kind, label, and event millisecond. Every stats entry point publishes a mark, so a missing span is unexpected. Unproven: whether the platform reused a span ID, an invocation ran without an active span and collided with a same-millisecond twin, or classic tail redelivered an event with changed content.
- **Recommendation:** Health now records each conflict's key source (`span` or `fallback`) with an example naming the invocation and the stored columns that differ; the one conflict from before is reported as `unrecorded`. Read `pnpm observe health` after a week. If fallback collisions dominate, add a field that separates same-millisecond invocations to the key; if span reuse does, key on trace and span together; if only `errors` differ, look at redelivery.
- **Fix with:** root-cause
- **Effort:** S

### STA-45 · P3 · Report each deployment's observed impact without being asked

- **Area:** Observability
- **Where:** `cloudflare/src/observe/client/cli.ts`, `cloudflare/src/observe/core/store.ts` (`rolloutImpact`)
- **Problem:** Whether a deploy brought new issue groups, regressions, a higher failure rate, or more CPU is answered only when someone runs `pnpm observe deployment <rollout>` or opens the deployment card. The Phase 5 review was this check done by hand, a day late, from sampled logs.
- **Recommendation:** A scheduled job, a cron agent or a host timer, that reads `pnpm observe issues --json` and `pnpm observe deployment <newest rollout> --json` for each observed service a few hours after each rollout, and files a ticket or posts a note only when there is a new issue, a regression, or a CPU or failure-rate change larger than the reported spread. It reports and proposes; it never pushes or deploys. Alert delivery is a campaign non-goal, so the destination and whether to build it at all are owner decisions.
- **Fix with:** none
- **Effort:** S

### STA-53 · P3 · Collector runs go missing or fail about one time in nine

- **Area:** Projects
- **Where:** `cloudflare/src/cloudflare/projects/collector.ts`, the stats `scheduled` handler
- **Problem:** From 08:50 to 11:00Z on 2026-11-05, 3 of 26 five-minute collector runs left no probe sample. The 09:35 and 09:40Z crons recorded no run at all, and the 10:05Z run recorded `collector_failed` after 5.2 s with 32M analytics rows read. Each gap removes a probe sample and delays settled coverage. Until `68396b7`, any one gap voided the probe guardrail, which is why O1 first came back `insufficient-data`.
- **Recommendation:** Read the stats-observe traces for the scheduled invocations at those times to tell a skipped cron from one that died before recording its run, and record the failing step of `collector_failed`. Fix the cause if it is ours; if Cloudflare skipped the crons, document the rate.
- **Fix with:** root-cause
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

