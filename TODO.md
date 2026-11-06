Prefix: STA
Next: 76

### STA-41 · P2 · Watch the usr-memories D1 size against the 10 GB cap

- **Area:** Operability
- **Where:** `cloudflare/src/cloudflare/projects/collector.ts`, `~/usr/agent-memory/cloudflare/src/db.ts`
- **Problem:** On 2026-11-01 after the backfill the database grew about 39 MB an hour (168, 208, and 246 MB at 20:00, 21:00, and 22:00 UTC) regardless of whether the hour wrote 226k or 819k rows, so rows written do not explain it. At that rate D1's 10 GB cap is about ten days away, and a database at the cap rejects writes. Unproven: whether the growth continues once the object pull and the snapshot bursts settle, and what the extra bytes are (snapshot rows, indexes, or free pages).
- **Recommendation:** Read the D1 size chart for a day. If growth continues, find which tables grow by running `SELECT name, SUM(pgsize) FROM dbstat GROUP BY name` through `cf d1` and compare with the per-snapshot `snapshot_object` rows, then decide between pruning old snapshots sooner and storing the object list once per change. Either is a stored-format or retention change and needs a yes first.
- **Fix with:** make-it-fast
- **Effort:** M

### STA-50 · P2 · Overlapping RPCs on one Durable Object lose their trace marks

- **Area:** Observability
- **Where:** `cloudflare/src/observe/cloudflare/tail.ts` (`readChannel`), `docs/architecture.md` (Sampling relies on each invocation's tail event)
- **Problem:** In local workerd, when RPCs overlap on one Durable Object instance, diagnostics-channel messages land on other invocations' tail events: five at a time produced events with zero to four messages. An object event with none is untraced, so a sampled service always keeps it. One with two operation messages is rejected as `rejected-invalid`. Nanoshop's one `TenantStore` object per shop is exactly this shape. Production is unmeasured.
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

### STA-61 · P2 · An offline host's history keeps answering 304 with aged-out points

- **Area:** Data
- **Where:** `cloudflare/src/core/installation/installation.ts:651`, `cloudflare/src/core/installation/responses.ts:36-38`, `cloudflare/src/core/installation/installation.ts:463-464`, `cloudflare/src/core/installation/installation.ts:320`, `cloudflare/src/client/api.ts:191`
- **Problem:** The host history ETag is built from `historyVersion`, `historyWindowKey`, and the kinds. For a range query the window key is `range=1h`, with no time in it, and the version changes only on ingest or a retention delete. When a host stops reporting, a conditional request three hours later still matches. It returns 304, and the dashboard keeps showing points that have aged out of the window. An unconditional request at the same moment returns 0 points. The audit reproduced this on the Node harness. Project history keys on `latestCollectorRunId` and goes stale the same way when a cron is skipped (see STA-53). Priority assumed.
- **Recommendation:** For range queries, put the resolved window end (`historyShape(...).toMs`) and the resolution into the ETag. Add a test with an offline host and a later conditional request.
- **Fix with:** durable-state
- **Effort:** S

### STA-62 · P2 · A failed observe flush loses the buffered exact counts

- **Area:** Data
- **Where:** `cloudflare/src/observe/core/count-buffer.ts:76`, `cloudflare/src/observe/core/count-buffer.ts:82`, `cloudflare/src/observe/cloudflare/worker.ts:51`
- **Problem:** `deliverSampled` calls `buffer.drain()` before it awaits `sink.ingest`. If the `ObservationStore` RPC throws (overload, SQL error, or the unnamed object in STA-51), the drained sampled-out counts are gone. On the due path the error only fails the tail invocation. On the idle path it is only logged as `observe_count_flush_failed`. The "exact" route totals then undercount, and no health counter records it. The audit reproduced this with a throwing sink: the buffer went from 1 entry to 0. Priority assumed.
- **Recommendation:** Re-add the drained counts when `ingest` rejects, or drain only after it succeeds. Add a rejecting-sink case to `cloudflare/test/observe/count-buffer.test.ts`.
- **Fix with:** lifecycle-concurrency
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

### STA-42 · P3 · Decide whether hosts should upload every 10 seconds

- **Area:** Operability
- **Where:** `agent/src/config.rs:150`, `README.md:66`, `cloudflare/src/core/installation/installation.ts:29`, `deploy/hosts.json`
- **Problem:** The default `uploadIntervalMs` is 30000 with `sampleIntervalMs` 15000, so each upload carries two samples and a host sends two ingest requests a minute. The allowed floor is 10000, which sends one sample per request at about four requests a minute. It buys about 20 s of delivery freshness, keeps `ONLINE_WINDOW_MS` (45 s) from flapping when one upload fails, and does not improve chart resolution, because raw history steps at 15 s and the 1m and 1h rollups sit on top. It doubles the request footprint: measured 2026-11-02, `stats` had 1,740 stateless entrypoint invocations in six hours, 760 of them `POST /ingest/v1/batches`, against `MAX_REQUESTS_PER_WINDOW` 6 per host per fixed minute, the free plan's 100,000 Worker requests a day, and the zone rule of 20 `/ingest/*` requests per 10 s per IP per colo. At 10 s one host is about 5,760 ingest requests a day, and a shared egress IP supports about 20 hosts before the zone rule, against about 34 and 60 at 30 s. Unproven: how often one missed upload actually pushes a host past the online window today.
- **Recommendation:** Leave the default at 30 s. If one host should feel live, set `"uploadIntervalMs": 10000` in its `/etc/stats/agent.json`, which a host deploy preserves, and read the 429 and `ingest_rejected` counts for a day. Revisit the default only when the fleet is known to stay small or the account leaves the free plan.
- **Fix with:** none
- **Effort:** S

### STA-43 · P3 · Retention alarm test flakes when workerd fires the alarm itself

- **Area:** Tests
- **Where:** `cloudflare/test/history.test.ts:266`
- **Problem:** "schedules another pass after a full retention batch" failed once in `make worker-test` on 2026-11-04 with 0 remaining rows where it expects 1, then passed 5 of 5 alone. The run logged "SQLite alarm overdue, running despite AlarmManager mismatch". The test sets the alarm `Date.now() + 1_000` ahead, so workerd's alarm manager can fire it alongside `runDurableObjectAlarm`, and two retention passes delete both batches. Unproven: that the double run is the cause rather than another timing race.
- **Recommendation:** Set the alarm far ahead (an hour) so only `runDurableObjectAlarm` runs it, then run the file 50 times to confirm the failure is gone.
- **Fix with:** root-cause
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

### STA-46 · P3 · Decide whether to cap stored JSON per ingest request

- **Area:** Ingest
- **Where:** `cloudflare/src/core/installation/installation.ts`, `docs/binary-ingest.md`
- **Problem:** A misbehaving host token can make the server store about 143 KB of canonical JSON per v2 request, against about 64 KB under v1. Rows per request and request rate are unchanged, and the real agent stores the same bytes as before.
- **Recommendation:** Decide whether to reject a batch whose decoded canonical JSON would exceed the old 64 KB bound, or accept the documented limit. If capped, add a conformance fixture and a Worker test for the boundary.
- **Fix with:** none
- **Effort:** S

### STA-53 · P3 · Collector runs go missing or fail about one time in nine

- **Area:** Projects
- **Where:** `cloudflare/src/cloudflare/projects/collector.ts`, the stats `scheduled` handler
- **Problem:** From 08:50 to 11:00Z on 2026-11-05, 3 of 26 five-minute collector runs left no probe sample. The 09:35 and 09:40Z crons recorded no run at all, and the 10:05Z run recorded `collector_failed` after 5.2 s with 32M analytics rows read. Each gap removes a probe sample and delays settled coverage. Until `68396b7`, any one gap voided the probe guardrail, which is why O1 first came back `insufficient-data`.
- **Recommendation:** Read the stats-observe traces for the scheduled invocations at those times to tell a skipped cron from one that died before recording its run, and record the failing step of `collector_failed`. Fix the cause if it is ours; if Cloudflare skipped the crons, document the rate.
- **Fix with:** root-cause
- **Effort:** S

### STA-55 · P3 · Rejected-invalid events from a sampled service are not capped

- **Area:** Observability
- **Where:** `cloudflare/src/observe/cloudflare/tail.ts` (`prepareTailItems`), `cloudflare/src/observe/core/always-kept-cap.ts`
- **Problem:** STA-52 caps always-kept invocations at 10 per isolate per bucket, but an event rejected as invalid (for example one carrying two operation messages, which STA-50 makes likely under overlapping RPCs) is still stored as a rejection with its outcome row, about 3 rows each, with no bound.
- **Recommendation:** Count rejections past the same cap in the bucket's counts instead of writing an outcome row per event, keeping the rejected total exact.
- **Fix with:** none
- **Effort:** S

### STA-56 · P3 · Explore hides a sampled route that has no kept invocation

- **Area:** Observability
- **Where:** `cloudflare/src/observe/core/store.ts` (explore), `cloudflare/src/client/` (route table)
- **Problem:** For a sampled service, explore lists only routes with at least one kept invocation, although the counts table holds every route's exact count. At 2,000 per million, a route with 1,000 requests in the window has about a 13.5% chance of no kept invocation, so quiet routes disappear from explore in production, and failures are the only kept rows a route is guaranteed.
- **Recommendation:** List every counted route with its exact `observed` count, and make the latency and CPU fields `null` with a sampled-out reason when nothing was kept. That changes the explore response and the dashboard route table, so update the decoder, the CLI, and the goldens together.
- **Fix with:** none
- **Effort:** S

### STA-57 · P3 · A refactor makes a pre-existing error look like a new issue group

- **Area:** Verification
- **Where:** `cloudflare/src/cli/verify/decide.ts` (`issueGuardrail`), `cloudflare/src/observe/core/grouping.ts` (`fingerprint`)
- **Problem:** The fingerprint hashes the in-app frames' function names, so a deploy that changes the call stack above a recurring error regroups it, and `new-issue-group` reports it as regressed. O2 (`d0fb1f45`) hit this: the `deployments.poll` error from `nanoshop-storied`'s missing Worker, which recurs every 5 minutes, was last seen under `31f2f398` at 15:50:49Z and first seen under `8ba50543` at 15:55:49Z with a new fingerprint. An unattended loop would roll that deploy back.
- **Recommendation:** When a candidate-first group has the same operation and error name as a group seen in the before window, report it as `regrouped`, naming both fingerprints, and have `verify` exit as confounded instead of regressed. That way the loop asks a person instead of rolling back, and a genuinely new error name or operation still regresses.
- **Fix with:** none
- **Effort:** S

### STA-58 · P3 · A 24h service comparison loads every 1m rollup for every marker host

- **Area:** Services
- **Where:** `cloudflare/src/core/installation/installation.ts` (service comparison read)
- **Problem:** A 24h window parses about 2,890 one-minute rollups per host, and up to 64 hosts, in one Durable Object request, which could exceed memory or CPU limits for a large service. Not measured; today's one-host use is far from it.
- **Recommendation:** Measure a 64-host, 24h comparison in workerd before any service has more than a few hosts, and read hourly rollups for windows longer than 6h if it is over budget.
- **Fix with:** none
- **Effort:** M

### STA-59 · P3 · An empty io.stat reads as measured zero service I/O

- **Area:** Agent
- **Where:** `agent/src/cgroup.rs` (`parse_io_stat`), `cloudflare/src/deployments/service-compare.ts`
- **Problem:** An empty `io.stat` parses as all-zero counters, and that zero `service.io` then replaces `host.disk`. On a filesystem that does not charge writeback to cgroups, a deploy that adds disk I/O would read as unchanged. This is unproven: threadripper reported nonzero io bytes on its first sample.
- **Recommendation:** Check on threadripper whether `io.stat` ever stays empty while the host disk is busy. If it does, send io as absent when `io.stat` has no device lines.
- **Fix with:** none
- **Effort:** S

### STA-60 · P3 · A host-metric service policy stops answering once cgroup data arrives

- **Area:** Services
- **Where:** `cloudflare/src/deployments/service-compare.ts` (the replacement filter), `cloudflare/src/cli/verify/service.ts`, `bench/policies/service-example.json`
- **Problem:** When a service has cgroup data in both windows, `service.*` replaces `host.cpu`, `host.memory`, and `host.disk` in `metrics`. A policy that targets a host metric, including the shipped example, then returns insufficient-data on every run. `stats-node` on threadripper gets there with its next marked deploy.
- **Recommendation:** Keep the replaced host rows in the response and mark them as superseded, so the page still leads with cgroup and a policy on `host.*` stays answerable. Alternatively, move the example policy to `service.cpu`.
- **Fix with:** none
- **Effort:** S

### STA-63 · P3 · Host deploy reports success without proving the new binary uploads

- **Area:** Operability
- **Where:** `deploy/deploy-host.sh:104-118`, `deploy/deploy-host.sh:188-193`, `deploy/deploy-host.sh:241-244`
- **Problem:** `prepare_receipt` takes the upload baseline before the install and restart. The old agent uploads every 30 s, so one of its uploads in that window satisfies `wait_for_upload`, and the script prints "deployed" without a receipt from the new binary. `deploy/add-host.sh` takes its baseline after the restart. Also, if a run installs the binary but times out waiting for a receipt, a re-run finds equal hashes and an active service, prints "unchanged", and exits 0 without checking for a receipt. Priority assumed.
- **Recommendation:** Take the baseline right after the restart or start. On the unchanged path, also run `prepare_receipt` and `wait_for_upload`.
- **Fix with:** none
- **Effort:** S

### STA-64 · P3 · One error signal serves four observe fetches, so failures vanish

- **Area:** Errors
- **Where:** `cloudflare/src/client/pages/project/Observe.tsx:91`, `cloudflare/src/client/pages/project/Observe.tsx:117`, `cloudflare/src/client/pages/project/Observe.tsx:146`, `cloudflare/src/client/pages/project/Observe.tsx:177`, `cloudflare/src/client/pages/project/Observe.tsx:211`, `cloudflare/src/client/pages/project/Observe.tsx:323`, `cloudflare/src/client/pages/project/Requests.tsx:112`
- **Problem:** The issues, explore, occurrences, and resolve-POST paths all write one `error` signal, and two of them clear it on success. The issues widget shows the error only while `issues()` is null. A failed Resolve re-enables the button with no message in the Errors section. A later failed issues refresh keeps the stale list with no notice. When explore fails and issues succeeds on the same tick, the success clears the explore error, so Requests shows stale data with no notice. Priority assumed.
- **Recommendation:** Keep one error signal per fetch (issues, explore, mutation). Render the issues and mutation errors in `IssuesWidget`.
- **Fix with:** make-invalid-states-unrepresentable
- **Effort:** S

### STA-65 · P3 · The project page keeps the first project's observed service after a hash change

- **Area:** Data
- **Where:** `cloudflare/src/client/pages/ProjectPage.tsx:50-62`, `cloudflare/src/client/pages/ProjectPage.tsx:139`, `cloudflare/src/client/pages/ProjectPage.tsx:147`, `cloudflare/src/client/pages/project/ledger-load.ts:57-73`
- **Problem:** `Show` is not keyed, so `ProjectView` survives a project change. Its `service` and `observe` are computed once from the first project. After changing the hash from `#/project/stats` to another project, the Errors and Requests sections keep querying the first project's service under the new header. No in-app link goes from one project to another, so you only reach this by editing the URL. Priority assumed.
- **Recommendation:** Remount on the project id, not on the project object, because each refresh builds new objects and keying on the object would remount every tick. Then drop the `loadedProject` flag in `Deployments.tsx:115-122`.
- **Fix with:** lifecycle-concurrency
- **Effort:** S

### STA-66 · P3 · The issue list relabels old rows before the new filter's data arrives

- **Area:** Data
- **Where:** `cloudflare/src/client/pages/project/Observe.tsx:191-192`, `cloudflare/src/client/pages/project/Observe.tsx:312`
- **Problem:** Choosing "Resolved" sets `issueState` and `introducedIn` before the refetch lands, and `IssuesWidget` labels the still-loaded open issues with the new state. They read "N resolved" until the response arrives, and indefinitely if the fetch fails (see STA-64). Priority assumed.
- **Recommendation:** Store the page together with the filter it answers, and show the skeleton while they differ from the current filter.
- **Fix with:** make-invalid-states-unrepresentable
- **Effort:** S

### STA-67 · P3 · Clicking the active range while zoomed does not leave the zoom

- **Area:** Data
- **Where:** `cloudflare/src/client/components/TimeBar.tsx:15`, `cloudflare/src/client/Shell.tsx:69-79`
- **Problem:** After a drag-zoom on the 1h range, the "1h" button shows as unpressed. Clicking it sets the same range value, the signal does not change, and `Shell.tsx:70-73` clears the zoom only when the range changes, so nothing happens. Priority assumed.
- **Recommendation:** Reset the zoom in the range click handler, and delete the `keepZoomOnRangeChange` flag if it becomes unneeded.
- **Fix with:** none
- **Effort:** S

### STA-68 · P3 · A failed deployments fetch in a list row reads "none recorded"

- **Area:** Errors
- **Where:** `cloudflare/src/client/pages/ProjectsPage.tsx:129-139`, `cloudflare/src/client/pages/ProjectsPage.tsx:227`, `cloudflare/src/client/pages/ServicesPage.tsx:64-74`
- **Problem:** On a 5xx, the row's `.catch` sets `deployments` to null and `settled` to true, so the row renders "none recorded" and wipes a deployment it already knew. `ProjectPage.tsx:241` shows `historyError` for the same failure. Priority assumed.
- **Recommendation:** Keep the last known value and render an error state in the row.
- **Fix with:** none
- **Effort:** S

### STA-37 · P4 · Approximate maximum CPU reads several times too high

- **Area:** Operability
- **Where:** `cloudflare/src/projects/queries.ts:24`, `cloudflare/src/cloudflare/projects/parse.ts`, `cloudflare/src/client/pages/project/Routes.tsx`
- **Problem:** `APPROX_MAX` returned 436 ms for `do.cpuMsMax` in an hour where the raw invocations peaked at 91 ms. The charts say "approximate" but a reader will take a spike as real. The Worker maximum uses the same function.
- **Recommendation:** Either drop the maximum charts, or label them as a sketch estimate that can read high, or derive the maximum from `SUM(cpuTimeUs * sampleInterval)` bounds, whichever the owner prefers.
- **Fix with:** none
- **Effort:** S

### STA-38 · P4 · Review the redesigned goldens and the live dashboard

- **Area:** Tests
- **Where:** `cloudflare/test/ui/replay.spec.ts-snapshots/`
- **Problem:** The 2026-11-01 dashboard rewrite regenerated 16 golden images with `--update-snapshots`. Only the threadripper 1 h charts and tiles and the stuff 1 h charts and tiles were looked at, and only on desktop for stuff. The 24 h and 7 d goldens, the mobile stuff pages, and the deployed page were not.
- **Recommendation:** Open each remaining golden and the deployed `#/project/stats` and `#/host/...` pages, and file or fix anything that reads wrong.
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
- **Fix with:** none
- **Effort:** S

### STA-49 · P4 · Nanoshop does not check its routes and operations against Stats' lists

- **Area:** Operability
- **Where:** `cloudflare/src/observe/core/nanoshop-policy.ts` (`NANOSHOP_ROUTES`, `NANOSHOP_RPC_METHODS`, `NANOSHOP_OPERATIONS`); Nanoshop's `src/routes/routes.ts` and `src/cloudflare/observe/operations.ts`
- **Problem:** Stats generates its matcher and operation set from exported data, but the data is copied by hand from Nanoshop. Nothing fails when Nanoshop adds a route or an error operation: the new route is excluded and the new operation is rejected, losing data silently.
- **Recommendation:** In Nanoshop's Stats integration tests, compare its `ROUTES` patterns and `ErrorOperation` set with the exported Stats lists.
- **Fix with:** single-source-of-truth
- **Effort:** S

### STA-69 · P4 · Agent retries with no pause on Retry-After: 0

- **Area:** Concurrency
- **Where:** `agent/src/backoff.rs:30-37`, `agent/src/runtime.rs:184-195`, `agent/src/runtime.rs:224-231`
- **Problem:** `Backoff::delay(Some(d))` returns the server's value with no floor. A 429 with `Retry-After: 0` makes `sleep_interruptible` return at once, and the upload loop retries immediately for as long as the 429s continue. The Worker sends `Retry-After: 60`, so only a fronting proxy could trigger this. Priority assumed.
- **Recommendation:** Floor the `Some` branch at the base delay and add a case to the backoff tests.
- **Fix with:** none
- **Effort:** S

### STA-70 · P4 · Agent flush accounting is decoded twice and has diverged

- **Area:** Types
- **Where:** `agent/src/runtime.rs:84-90`, `agent/src/runtime.rs:205-233`, `agent/src/runtime.rs:250-267`, `agent/src/runtime.rs:155-158`
- **Problem:** `FlushOutcome` is four optional fields for four states (idle, sent, retry, dropped). The upload loop and the final-flush loop each decode them with five checks into `RunReport`. The copies differ: only the upload loop resets the backoff and reloads the token on a credential failure. `flush_batch` decides its own backoff reset from a `pending` count read before the trimmed tail is requeued. Priority assumed.
- **Recommendation:** Make `FlushOutcome` an enum, and record it into `RunReport` in one function.
- **Fix with:** make-invalid-states-unrepresentable
- **Effort:** S

### STA-71 · P4 · Deploy scripts keep running after SIGINT or SIGTERM

- **Area:** Operability
- **Where:** `deploy/deploy-host.sh:74`, `deploy/add-host.sh:26`, `deploy/deployed-smoke.sh:6`
- **Problem:** `trap '...' 0 1 2 15` runs the cleanup on a signal and then continues the script. On macOS `sh`, a probe killed mid-`sleep` ran the cleanup, ran the next steps, and exited 0. A signal from a timeout wrapper removes `$work` and the remote temp file, and then the deploy continues. Not checked under Linux dash. Priority assumed.
- **Recommendation:** Give the signal traps their own handler that exits 130 or 143, and keep cleanup on EXIT only.
- **Fix with:** os-boundaries
- **Effort:** S

### STA-72 · P4 · Ctrl-C during the Access credential fetch reports an auth failure

- **Area:** Errors
- **Where:** `cloudflare/src/cli/auth.ts:55-74`, `cloudflare/src/cli/http.ts:94`, `cloudflare/src/cli/verify/loop.ts:112`, `cloudflare/src/cli/commands/verify.ts:149`
- **Problem:** A SIGINT while `cf access token` runs aborts the spawn. Its `error` event rejects with `credential_unavailable`, and `http.ts:94` awaits the credential outside the `try` that maps aborts to `cancelled`. `verify` then exits 3 with a "run cf access login" hint instead of saving state and exiting 5 with a resume command, as documented. Priority assumed.
- **Recommendation:** In `fetchCredential`, reject with a `cancelled` transport error when `signal.aborted`.
- **Fix with:** error-model
- **Effort:** S

### STA-73 · P4 · Purging a host leaves it in service host lists

- **Area:** Data
- **Where:** `cloudflare/src/core/installation/installation.ts:164-176`, `cloudflare/src/core/installation/services.ts:20-36`, `cloudflare/src/deployments/service-compare.ts:106`, `cloudflare/src/deployments/service-compare.ts:132`
- **Problem:** `purgeHost` does not touch `services.host_ids` or `service_deployments.host_ids`. `hostLevelRows` requires a value from every listed host, so a purged host makes every host metric for that service's markers absent, and the source status says no host reported enough rollups even when others did. Priority assumed.
- **Recommendation:** Refuse the purge with 409 while a service lists the host, or name the missing hosts in the comparison.
- **Fix with:** durable-state
- **Effort:** S

### STA-74 · P4 · The Node timer scheduler re-arms after stop

- **Area:** Concurrency
- **Where:** `cloudflare/src/node/ports.ts:23-33`, `cloudflare/src/node/probes.ts:19-23`, `cloudflare/src/node/installation.ts:61-65`, `cloudflare/src/core/installation/installation.ts:467`
- **Problem:** `stop()` clears the timer, but `at()` always re-arms it. A probe run or alarm that is in flight during `close()` re-arms the timer from its `finally`, and the timer then fires against the closed database every 5 minutes. The timers are unref'd, so the production server exits cleanly. Only tests or embedders that keep the process alive see it. Priority assumed.
- **Recommendation:** Make `stop()` latch, so that `at()` after it does nothing.
- **Fix with:** lifecycle-concurrency
- **Effort:** S

### STA-75 · P4 · A signal during local stack startup leaves scratch state behind

- **Area:** Operability
- **Where:** `cloudflare/scripts/local-stack.mjs:34-44`, `cloudflare/local/stack.ts:198`
- **Problem:** `startStack` creates `.work/tmp/stack-<pid>-*`, but the `exit` handler that removes it is registered only after `seed`. A SIGINT during startup reaches Miniflare's exit hook, which exits before the `finally` runs, so the directory stays. Read from code, not run. Priority assumed.
- **Recommendation:** Register the removal before `seed`.
- **Fix with:** none
- **Effort:** S
