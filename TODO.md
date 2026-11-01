Prefix: STA
Next: 41

### STA-31 · P3 · Collector store write still costs about 26 ms of Durable Object CPU per run

- **Area:** Performance
- **Where:** `cloudflare/src/projects/store.ts:57`, `cloudflare/src/projects/store.ts:101`
- **Problem:** `events.durableObjectsInvocations` shows the cron's store write (`invocationType = 'jsrpc'`) at 19 to 37 ms per run before 2026-11-01 20:30, and 22 to 28 ms for the four runs after `edfeea3` replaced the per-point SELECT with one range read. The route and Durable Object metrics added about 80 points per project in the same window, so the change probably absorbed that cost rather than cutting the old one. `rebuildHour` still runs two SELECTs and an INSERT for every changed metric and hour. Unproven: which of the two dominates.
- **Recommendation:** Read the stored `project_hours` values for the affected hours in one query and compute the hour aggregates in one grouped query, then write only the changed rows. Compare `jsrpc` CPU from the same dataset before and after.
- **Fix with:** make-it-fast
- **Effort:** S

### STA-32 · P3 · Dashboard history reads cost 35 to 55 ms of CPU each

- **Area:** Performance
- **Where:** `cloudflare/src/installation.ts:327`
- **Problem:** In `events.durableObjectsInvocations` the HTTP calls with about 88 KB responses took 52 and 55 ms of CPU on 2026-11-01 (a third took 34 ms at 83 KB), against a 5.3 ms average for all HTTP calls. `buildHistory` parses the payload and delta JSON of every raw sample in the window on a cache miss, and the four-window `historyCache` is lost whenever the object is evicted. Unproven: the parse is the dominant cost.
- **Recommendation:** Profile one raw-resolution read by phase (SQL, parse, `rollupPoints`, `compact`). If parsing dominates, read the 1m rollups for windows that do not need 15 s steps, or keep the parsed window across requests only while the object is alive and say so.
- **Fix with:** make-it-fast
- **Effort:** M

### STA-33 · P3 · Ingest CPU tail of 35 to 47 ms is unexplained

- **Area:** Performance
- **Where:** `cloudflare/src/installation.ts:431`
- **Problem:** The slowest HTTP calls with 49-byte (ingest) responses took 33 to 47 ms of CPU on 2026-11-01, against 5.3 ms for the average HTTP call. A Node microbenchmark of the pure-JS phases on `fixtures/v1/batch-full.json` came to about 0.8 ms per ingest, 0.64 ms of it the hour rebuild, so the tail is not JS. SQLite work or a cold wake is the suspect. Unproven.
- **Recommendation:** Count `rowsRead` and `rowsWritten` per statement for one ingest in a test, and compare slow and fast invocations by wall time against CPU. Do not move the hour rebuild until that shows it matters, because deferring it changes how fresh the 90-day charts are.
- **Fix with:** make-it-fast
- **Effort:** M

### STA-34 · P3 · The Durable Object's own SQLite size is not tracked

- **Area:** Operability
- **Where:** `cloudflare/cloudflare.config.ts:34`, `cloudflare/src/projects/collector.ts`
- **Problem:** The `stats` project has no storage chart because it lists no R2 bucket and the analytics catalogue has no Durable Object storage dataset; only R2, D1, KV, Vectorize and Cache Reserve have `states.*` datasets. The object's size is the figure that matters for the retention limits, and nothing reports it.
- **Recommendation:** Have the collector record `ctx.storage.sql.databaseSize` (in the workers types) as a gauge metric such as `do.storageBytes` for the project that owns the object, show it as a storage chart, and document that it is self-reported.
- **Fix with:** none
- **Effort:** S

### STA-35 · P3 · Long dashboard pages have no section navigation and unbalanced columns

- **Area:** Navigability
- **Where:** `cloudflare/src/client/pages/HostPage.tsx`, `cloudflare/src/client/pages/ProjectPage.tsx`, `cloudflare/src/client/style.css:370`
- **Problem:** Widgets now collapse, but the host page is still CPU, Memory, Network and a table in one stack, and the project page has two columns of different length. The only way to jump is a summary tile, which is not visible after scrolling.
- **Recommendation:** Add a sticky section bar built from the same cells and anchors as the strip, with its status dots, and balance the project columns by widget height.
- **Fix with:** none
- **Effort:** S

### STA-36 · P3 · Re-run the Worker parity check after a day of data

- **Area:** Tests
- **Where:** `cloudflare/scripts/check-parity.mjs`, `docs/operations.md:80`
- **Problem:** Stored history restarted at 2026-11-01 19:20 UTC after the Worker rename, so the 24 hour comparison of stored buckets against `cf sql query` has no full day to compare yet.
- **Recommendation:** On or after 2026-11-02 19:20 UTC run `node cloudflare/scripts/check-parity.mjs` (needs `cf access login`). If it fails above 5% total error, record why in `docs/operations.md` next to the existing miss.
- **Fix with:** none
- **Effort:** S

### STA-37 · P4 · Approximate maximum CPU reads several times too high

- **Area:** Operability
- **Where:** `cloudflare/src/projects/queries.ts:24`, `cloudflare/src/projects/parse.ts`, `cloudflare/src/client/pages/project/Routes.tsx`
- **Problem:** `APPROX_MAX` returned 436 ms for `do.cpuMsMax` in an hour where the raw invocations peaked at 91 ms. The charts say "approximate" but a reader will take a spike as real. The Worker maximum uses the same function.
- **Recommendation:** Either drop the maximum charts, or label them as a sketch estimate that can read high, or derive the maximum from `SUM(cpuTimeUs * sampleInterval)` bounds, whichever the owner prefers.
- **Fix with:** none
- **Effort:** S

### STA-38 · P4 · Review the redesigned goldens and the live dashboard

- **Area:** Tests
- **Where:** `cloudflare/test/ui/replay.spec.ts-snapshots/`
- **Problem:** The 2026-11-01 redesign regenerated 35 golden images with `--update-snapshots`. Only the stuff 1h tiles, left, right and mobile tiles, and the threadripper 1h tiles and left column were looked at. The 24h and 7d goldens, the mobile host pages, and the deployed page were not.
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
