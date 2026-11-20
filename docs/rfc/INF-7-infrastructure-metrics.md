# RFC INF-7: typed infrastructure metrics

Status: receiver and native collector implemented, 2026-11-20. Campaign item INF-7 in the
[infrastructure release campaign](../CAMPAIGN-INFRA-RELEASE.md). Depends on INF-2 (one metrics
port per Worker) and INF-3 (`openorange-release-manifest/1`).

## Decision

Store allowlisted Prometheus samples in a new `MetricStore` actor that sits outside the
`Installation` and `ObservationStore` schemas and outside the logical backup. A separate private
collector scrapes every Worker port and the Engine, then posts typed JSON batches to
`POST /ingest/metrics/v1/batches` with a reserved `stats-infra` credential. STB2, STA2,
`fixtures/v2/`, the 16-table canonical fingerprint and the backup object list stay unchanged, so
an older Stats release keeps serving, exporting and importing exactly as it does today.

## Evidence from the current code

- Pinned OpenOrange 1.0.2 (`deploy/orange/package.json:12`) serves metrics only from Worker 0
  (`deploy/orange/node_modules/open-orange/dist/bin.js:8535`). The listener binds `127.0.0.1`
  (`dist/runtime/runner.js:22724`) and renders `prometheusMetrics()` inside the Worker runtime
  process (`runner.js:26741-26746`), so every scrape costs application CPU. Stats collects no
  runtime gauges today (`docs/platform-observability.md:18-20`, `packages/platform-bridge/src/contract.ts:39`).
- The export enumerates every non-internal table in `sqlite_master` except the caller's derived
  set (`cloudflare/src/core/export/snapshot.ts:88-90`), and the fingerprint hashes that list
  (`snapshot.ts:138-142`). Import requires identical table names and definitions
  (`snapshot.ts:206-213`). Every `ObservationStore` gets the same 16 tables
  (`cloudflare/src/observe/core/store.ts:314-466`), and the derived set is two fixed names
  (`cloudflare/src/observe/application/schema.ts:6`). Readers that predate a derived table export
  it as canonical and are unsafe rollback targets (`docs/openorange.md:209-219`).
- The backup object list is `installation` plus `observe:<service>`
  (`cloudflare/src/core/http.ts:167-176`). A POST to an unknown path answers 405 (`http.ts:264`).
- STB2 bits 13 and above are reserved, and a reserved bit rejects the whole frame
  (`docs/protocol.md:139`, `:335`). The agent drops a batch on 400 (`protocol.md:434`). Agent
  `seq` is `floor(monoMs / 1000)` (`docs/architecture.md:91`), so it steps by about 15. The agent
  has one sampling loop and one upload thread (`agent/src/runtime.rs:331-340`).
- The release gate consumes producer checkpoints `{startedAtMs, atMs, accepted, dropped, queued}`.
  Complete delivery requires one producer session, an accepted delta equal to received, unchanged
  dropped counts and empty queues at both checkpoints.
- The bridge reports its delivery counters as an artificial `platform.bridge` application event
  (`packages/platform-bridge/src/server.ts:53-56`, read back in
  `cloudflare/src/observe/platform/query.ts:50-56`); INF-7 does not repeat this. The reserved
  `stats-platform` sink checks an environment verifier (`cloudflare/src/cloudflare/index.ts:56-58`)
  that the registry cannot shadow (`cloudflare/src/core/installation/services.ts:244`). HTTP
  capture skips `/ingest/observe/` (`cloudflare/src/observe/application/http.ts:29`).
- The Engine retries alarms forever for Stats actors without a runner, which cost 0.35 cores on
  2026-11-19 (`docs/openorange.md:191-196`). `ObservationStore` arms alarms
  (`cloudflare/src/observe/cloudflare/store-object.ts:56-63`).
- Native hosts bind the Engine metrics and Stats listeners to loopback (`docs/native-lisa.md:39-41`,
  `:299-300`). On Docker Lisa the bridge is its own container (`docs/native-lisa.md:257`), while a
  Worker's port is on its own container loopback.

## Criteria, fixed before comparison

1. Wire: STB2 and STA2 do not change, and `fixtures/v2/` stays the host oracle.
2. Persisted format: canonical tables, fingerprint and backup object list do not change.
3. Rollback: production `accd14a0364c` runs, exports and imports against new state without a
   reader-first release.
4. Bounds: closed family allowlist, closed label values, per-scrape and per-store caps.
5. Gate queries: per-source sequence, drops, rejections, queue high-water, freshness and restarts,
   bound to one release.
6. Non-interference: bounded queues, timeouts and retries; no application wait; no self-observation.
7. Semantics: typed counters, gauges and histograms, resets as gaps, Worker identity kept.
8. Implementation cost.

## Designs compared

- **A.** The host agent scrapes and sends STB2 group bit 13, stored in `samples`.
- **B.** The bridge scrapes and posts to a new route; `observe_metric_*` tables join the
  `stats-platform` store, canonical or declared derived.
- **C.** A dedicated collector posts to a new route; a new `MetricStore` actor (a SQLite file on
  Node) holds the data outside every canonical schema and outside the backup.
- **D.** The rollout controller scrapes during the window and writes `observations.json` itself.

| Criterion | A | B | C | D |
| --- | --- | --- | --- | --- |
| 1 Wire | Breaks: old receivers reject bit 13; fixtures regenerate in Rust and TS | None | None; new `fixtures/metrics/v1/` corpus | None |
| 2 Persisted | Tables unchanged; `samples` payloads and rollups grow | Fingerprint changes in every `observe:*`, or "derived" labels data no trigger rebuilds (`snapshot.ts:15`) | None | None |
| 3 Rollback | Old receiver returns 400, so agents drop host samples too | Needs a reader release that excludes the tables first | Old release answers 405 and never opens the store | None |
| 4 Bounds | 16 entries per kind per sample (`protocol.md:289`); 64 KiB shared with host data | Shares 120 batches per minute (`cloudflare/src/observe/ingest/model.ts:5-6`) | Own caps | Per bundle |
| 5 Gate | `seq` steps by about 15, so `received` cannot reconcile | Feasible | Exact source shape | Evidence comes from the rollout controller, not Stats |
| 6 Interference | Scrape timeouts in the sampling loop or a third thread | Shares the 128 MiB bridge; its container cannot reach Worker loopback | Separate bounded process on the target host | Controller side |
| 7 Semantics | Feasible | Feasible | Feasible | No history; fails INF-7 readback |
| 8 Cost | High | Medium plus a two-step deploy | Medium | Low |

C alone meets criteria 1 to 3 and still stores the data. B fails criterion 3 because any new table
in a shared schema changes what older readers export. A fails criteria 1, 3 and 5, and its
rollback loses host telemetry as well as metrics. D fails the INF-7 acceptance and loses the
history the 2026-11-19 Engine load attribution needed (`docs/openorange.md:180-199`). C takes the
reserved-credential mechanism and delivery bounds from B (`packages/platform-bridge/src/main.ts:12`)
and the gap rules from A (`docs/protocol.md:446-448`).

## Specification

### Collector

`packages/infra-collector` is a dependency-free Node entry point, bundled like the bridge by a
script beside `cloudflare/scripts/build-platform-bridge.mjs`. Stuff owns its OpenRC unit and
protected configuration. It runs on the host that owns the target loopback, never in the
application process.

- Config: a collector `name` (`[a-z][a-z0-9-]{0,31}`), at most 16 targets `{id, url}`, a release
  file and a token file. The token is reread on 401 or 403 and never reaches argv or logs.
- Target ids are `worker:<worker>:<index>` (index 0 to 15) or `engine:<name>`. A Worker scrape
  whose `openorange_worker_info{worker,index}` does not match its id records `identity_mismatch`
  and discards the values, which catches port shifts.
- Scrapes run every 15 s with 1 s jitter, one in flight per target, a 2 s deadline, a 4 MiB body
  cap and no retry. A failure is recorded with outcome `timeout`, `refused`, `http_status`,
  `too_large`, `parse_error` or `identity_mismatch`.
- Delivery queues at most 32 batches, one per scrape round (about 8 minutes), and drops the oldest
  with a count on overflow. One POST is in flight, with a 5 s timeout and one retry. `Retry-After`
  is honoured up to 60 s. A 404, 405, 410, 415 or 422 drops the batch, counts it as `rejected`
  and backs off 60 s.
- Limits: 64 MiB memory, a 5 s shutdown flush, one log line per error code per minute, no label
  values or bodies in logs, and no Engine token.
- Self-observation: the collector emits no application events; its health rides in the typed
  batch header. Stats adds `/ingest/metrics/` to the capture skip list (`application/http.ts:29`).
  The bridge already filters spans from a third actor (`packages/platform-bridge/src/project.ts:40`, `:58-62`).

### Allowlist catalog

`packages/infra-collector/src/catalog.ts` is the single source of truth. The collector and the
server validator import it, as `platform/query.ts:4` imports the bridge contract. Each entry fixes
`name`, `source` (`rivetkit`, `openorange` or `engine`), `type`, label keys with closed value
sets, the histogram `le` layout, the value form (`u64` or `decimal`) and provenance. The catalog
has an integer `version`. A family enters v1 only when a captured scrape in
`fixtures/metrics/v1/scrapes/` contains it. A family that exposes an unlisted label key is
dropped whole and never merged, because summing across a dropped label turns a vanished member
into a false counter decrease.

The candidates below marked *strings* appear in `strings` output of the pinned
`rivetkit-napi.darwin-arm64.node` 3.1.2-rc.1 and of `rivet-engine` from `engine-cli-darwin-arm64`
3.1.2-rc.1 under `deploy/orange/node_modules/.pnpm/`. RivetKit help strings show the exposed
`rivetkit_` prefix. Engine prefixes and label keys are unknown, and Lisa's Engine carries private
patches (INF-11). Every row stays unverified until a real scrape confirms it.

| Signal | Families (type) | Provenance |
| --- | --- | --- |
| Worker identity | `openorange_worker_info{worker,index}`, `openorange_worker_start_time_seconds`, `rivetkit_info` (gauges) | INF-2 brief; strings |
| Active actors | `rivetkit_actor_active_count` (gauge) | strings |
| Requests in flight | `rivetkit_actor_http_requests_active`, `rivetkit_envoy_client_actor_queued_requests`, `..._capacity` (gauges); `rivetkit_envoy_client_actor_queued_requests_overloaded_total` (counter) | strings |
| Inbox depth | `rivetkit_actor_inbox_depth{inbox}`, `rivetkit_actor_queue_depth` (gauges) | strings |
| Activation | `rivetkit_actor_started_total`, `rivetkit_actor_stopped_total` (counters); `rivetkit_envoy_client_actor_start_seconds` (histogram) | strings |
| Sleep and drain | `rivetkit_actor_shutdown_tasks_active`, `rivetkit_actor_keep_awake_active` (gauges); `rivetkit_actor_shutdown_wait_seconds` (histogram); `rivetkit_actor_shutdown_timeout_total` (counter) | strings |
| SQLite | `rivetkit_sqlite_worker_queue_depth`, `rivetkit_sqlite_worker_inflight`, `rivetkit_envoy_client_sqlite_requests_inflight` (gauges); `rivetkit_actor_sqlite_vfs_commit_total`, `rivetkit_envoy_client_sqlite_request_expired_total` (counters); `rivetkit_actor_sqlite_vfs_get_pages_duration_seconds` (histogram). Families labelled by `fingerprint` are excluded | strings |
| Runtime telemetry loss | `rivetkit_sqlite_event_dropped_total`, `rivetkit_envoy_client_http_detached_send_dropped_total` (counters) | strings |
| Engine storage and flush backlog | `depot_cold_store_unflushed_bytes`, `depot_cold_store_unflushed_capacity_bytes`, `depot_tablet_store_queue_depth` (gauges); `depot_tablet_flush_deferred_volumes_total`, `depot_cold_store_l0_stalls_total`, `depot_cold_store_backpressure_total` (counters) | strings |
| Engine overload and refusals | `depot_filesystem_overloaded_total`, `depot_client_rejected_total`, `depot_tablet_volume_refusals_total`, `pegboard_actor_effect_refusals_total`, `ups_request_queue_rejected_total` (counters) | strings |
| Engine retries | `depot_object_store_retries_total`, `pegboard_namespace_retries_total` (counters) | strings |
| Alarm delivery and retries | `pegboard_actor_alarm_retries_total`, `depot_alarm_hints_dropped_total`, `depot_alarm_discovery_rows_total` (counters) | strings |
| Lease and fence | `depot_lease_degraded_refusals_total`, `depot_tablet_maintainer_fences_total` (source-file label values need a closed map), `depot_coordinator_regrants_total` (counters) | strings |
| Registration failures | None found; `rivetkit_envoy_client_ws_reconnect_total{reason}` is the nearest Worker-side signal | gap |
| Engine process start | No `process_start_time_seconds` in either binary | gap |

### Batch wire shape

The request is `POST /ingest/metrics/v1/batches` with `Content-Type:
application/vnd.stats.infra-metrics.v2+json`, at most 64 KiB and 16 scrapes. All objects are
strict. Integers are JSON numbers up to 2^53-1, and metric values are strings.

```json
{ "schema": "stats-infra-metrics/2", "catalog": 1,
  "collector": { "name": "infra-standby", "instance": "<16 hex>", "startedAtMs": 1763650000000 },
  "expected": ["worker:stats-observe:1"],
  "delivery": { "atMs": 1763650011000, "queued": 0, "queueHigh": 3,
    "targets": { "worker:stats-observe:1": { "scraped": 1841, "accepted": 1841,
      "duplicates": 0, "rejected": 0, "dropped": 0, "failed": 0 } } },
  "scrapes": [{ "target": "worker:stats-observe:1", "sequence": 1842,
    "atMs": 1763650012000, "monoMs": 912000, "outcome": "ok", "durationUs": 8123, "bytes": 48211,
    "release": { "runtime": "rt-0123456789ab", "app": "accd14a0364c" },
    "process": { "startTime": "1763640000.123" },
    "dropped": { "unlisted_family": 812, "unlisted_label": 3, "non_finite": 0, "series_cap": 0 },
    "values": {
      "rivetkit_actor_active_count": [[{}, "2"]],
      "rivetkit_actor_shutdown_wait_seconds": [[{}, { "buckets": ["0", "1", "1"], "count": "1", "sum": "0.25" }]] } }] }
```

`sequence` is contiguous per `(collector.instance, target)` from 1 and includes failed scrapes.
`release.runtime` is the runtime release id and matches `^rt-[0-9a-f]{12}$`. `release.app` is the 12-hex Stats release, or null
for an Engine target. The collector rereads both from the release file at each scrape. A `u64`
value is canonical decimal from 0 to 2^64-1. A `decimal` value is a finite Prometheus float token
of at most 32 characters, stored verbatim, and its deltas use scaled-integer arithmetic.

### Validation and response

A structural fault rejects the whole batch with 400 `invalid_batch` and a fixed reason, and
nothing is written. Faults include an unknown key, catalog version, family or label value, a type
or layout mismatch, a bucket that decreases along `le`, a final bucket unequal to `count`, a
non-canonical number and a cap overrun. A 200 body has `{accepted, duplicates, rejected: [{target, sequence, code}], outcomes}`.
Each outcome identifies a target and sequence and has status `accepted`, `duplicate` or `rejected`.
The collector removes a batch only when the counts, rejection entries and unique outcomes account
for every scrape in it. Retried duplicates count as acknowledged delivery. Codes
are `too_old`, `future` (over 5 minutes ahead) and `conflict`. A repeated `(collector, instance,
target, sequence)` with identical canonical payload is a duplicate; different content is a
conflict that keeps the first row. A store rejects with `capacity` beyond 32 live `(runtime, app)`
pairs or 8 collector names, and accepts at most 12 batches per minute per collector.

### Storage

Each reserved scope, starting with `stats-infra`, gets one `MetricStore`: a new SQLite Durable
Object class beside `ObservationStore` (`cloudflare/observe-worker/cloudflare.config.ts:12-16`),
whose binding `deploy/orange/generate.mts:49` emits. On Node it is
`stats.sqlite.metrics/<scope>.sqlite`, beside the per-service files
(`cloudflare/src/node/observations.ts:48-56`).

```sql
CREATE TABLE metric_scrapes (
  collector TEXT NOT NULL, instance TEXT NOT NULL, target TEXT NOT NULL, sequence INTEGER NOT NULL,
  at_ms INTEGER NOT NULL, mono_ms INTEGER NOT NULL, received_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, outcome TEXT NOT NULL, runtime_release TEXT NOT NULL,
  app_release TEXT, incarnation TEXT, catalog INTEGER NOT NULL,
  payload TEXT NOT NULL,  -- canonical JSON: values, dropped, durationUs, bytes; at most 8 KiB
  PRIMARY KEY (collector, instance, target, sequence)) WITHOUT ROWID;
CREATE INDEX metric_scrapes_time ON metric_scrapes (target, at_ms);
CREATE TABLE metric_deliveries (
  collector TEXT NOT NULL, instance TEXT NOT NULL, received_at INTEGER NOT NULL,
  expected TEXT NOT NULL, queued INTEGER NOT NULL, queue_high INTEGER NOT NULL,
  dropped INTEGER NOT NULL, retries INTEGER NOT NULL, rejected INTEGER NOT NULL,
  PRIMARY KEY (collector, instance, received_at)) WITHOUT ROWID;
CREATE TABLE metric_snapshots (collector TEXT NOT NULL, instance TEXT NOT NULL, at_ms INTEGER NOT NULL,
  started_at INTEGER NOT NULL, expected TEXT NOT NULL, queued INTEGER NOT NULL,
  queue_high INTEGER NOT NULL, targets TEXT NOT NULL,
  PRIMARY KEY (collector, instance, at_ms)) WITHOUT ROWID;
CREATE TABLE metric_rejections (bucket_at INTEGER NOT NULL, collector TEXT NOT NULL,
  reason TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (bucket_at, collector, reason)) WITHOUT ROWID;
CREATE TABLE metric_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
```

Schema changes are additive only (new tables or nullable columns, which readers ignore); a
non-additive change gets a new store name. The store arms no alarm. Each ingest deletes up to
`max(64, 2 × inserted)` rows with `expires_at <= now`, then evicts and counts the oldest rows
beyond 20,000. Every read filters `expires_at > now`. A dormant store after rollback therefore
gives the Engine nothing to retry.

### Identity, resets and histograms

- Worker identity is `(target, incarnation)`, where `incarnation` is the
  `openorange_worker_start_time_seconds` text and the `worker` and `index` labels match the target.
- A counter delta exists only between two `ok` scrapes of one collector instance with the same
  incarnation, increasing `mono_ms` and no decrease. A rate divides by its own covered interval,
  so a lost scrape widens the interval and never lowers the rate.
- A new incarnation is a reset: the target pair is a gap and counts in `resets`. A decrease inside
  one incarnation is a gap for that series and counts in `counter_regressions`. A collector
  restart is a gap. No read produces a negative rate. The Engine exposes no start time, so any
  allowlisted Engine counter that decreases marks a reset for the whole pair.
- Gauges are levels, never rates.
- Histograms keep cumulative buckets, `count` and `sum` per process, and reads return per-interval
  bucket deltas per incarnation. Merging processes only sums bucket deltas with identical layout
  and interval. Displayed quantiles are bucket upper bounds (`docs/platform-observability.md:109-110`).
  Nothing averages percentiles.

### Retention and budgets

Raw scrapes are kept 24 hours at a 15 s interval: 17,280 rows a day for three targets, about
35 MiB at an expected 2 KiB each and 141 MiB at the 8 KiB cap. `ObservationStore` keeps 200,000
invocations under 512 B each for comparison (`docs/observe.md:239`, `:257`). One-minute rollups
for 7 days come later and follow the host rules (`docs/architecture.md:793-799`).

The production Engine exposed 1,421,880 bytes across 302 families. In the native
rehearsal, the active external Engine exposed 1,175,390 bytes. The collector
filters lines while streaming and retains only catalog samples. A Linux arm64
probe with a 64 MiB cgroup limit completed one 16-target round of 4,147,780-byte
synthetic scrapes, with four scrapes in flight, without an OOM. This probe does
not cover sustained queue saturation or TLS.

### Reads for the release gate

`GET /api/observe/stats-infra/metrics/sources?from=MS&to=MS&release=runtime|app` uses the normal
gateway authorization. Each `(target, collector)` has evidence and detail. The first checkpoint is
the last producer snapshot at or before `from`; the second is the first at or after `to`. If either
is unavailable, detail reports `window-open` and evidence is null. A collector instance change
reports `collector-restart`; a last OK scrape more than 45 seconds before `to` reports `stale`.
Each catalog family applicable to the target has `okSamples`, `usable` and `reason`: usability
requires two OK samples in one collector instance and incarnation; absence is `family-missing`.

A snapshot records the collector wall time and per-target cumulative scraped, acknowledged accepted,
duplicate, rejected, dropped and acknowledged failed scrape counts. Queue depth includes the in-flight batch. Checkpoint
`accepted` is acknowledged accepted plus duplicate; checkpoint dropped includes rejected and dropped
scrapes and failed scrape outcomes. Received counts distinct stored sequences between
the bracketing snapshots. Detail exposes the maximum snapshot queue depth observed inside the window
and the separate lifetime high watermark. The watermark never changes checkpoint queue depths.

Actor names map to `installation`, `observation-store`, `metric-store`, `cron`, or `other` before
delivery. Counters and histogram buckets sum within a role; gauges take the maximum. Raw actor names,
keys and ids do not enter metric labels. Detail includes the last OK values for query consumers.

## Migration and rollback

1. Release R1 ships the receiver dormant: class, binding, route, reserved name, capture skip and
   an `infraMetrics` capability. Without `INFRA_METRICS_TOKEN_SHA256` the route answers 503, as
   `stats-platform` does (`index.ts:56-58`). No actor exists before the first accepted batch.
2. Stuff provisions the verifier and starts the collector on the standby writer, a native host
   whose Worker and Engine listeners share loopback. Docker Lisa waits for owner decision 2.
3. To roll back, select the previous image (`docs/openorange.md:104`). The old release answers
   405 and the collector counts rejections. Objects, tables and fingerprint are unchanged, so no
   restore is needed, unlike a schema migration (`openorange.md:105-106`).
4. Rolling forward resumes ingest, and old rows expire inline. Retiring stops the collector and
   removes the binding later; abandoned state stays within the row cap.

## Tests that prove it

Each suite below fails when the property it names breaks.

| Test | Proves |
| --- | --- |
| `cloudflare/test/metrics/exposition.test.ts` | Captured scrapes parse to golden batches; the malformed corpus (duplicate series, non-cumulative buckets, final bucket unequal to `count`, NaN counter, unlisted label, type change, oversize body) rejects; every catalog family occurs in a fixture |
| `cloudflare/test/metrics/store.test.ts` | Exact `2^64-1` and decimal round trips; duplicate versus conflict; start-time reset and same-incarnation decrease are gaps; histogram deltas stay per process; retention filter, inline cleanup and counted eviction |
| `cloudflare/test/metrics/sources.test.ts` | Fed to `decideRelease`, a lost sequence, failed scrape, collector restart or missing target is `inconclusive`; a clean window passes delivery |
| `cloudflare/test/api.test.ts`, `cloudflare/test/observe/application-http.test.ts` | 401, 503 without verifier, 415, 413, strict-key 400; metric ingest records no application event |
| `cloudflare/test/node/snapshot.test.ts` | `installation` and `observe:*` table lists and schema SHA-256 equal values pinned from `accd14a0364c`; `/admin/objects` lists no metric object |
| `cloudflare/test/local/upgrade.test.ts` | After R1 writes metrics, the baseline build serves health, hosts and history, exports the pinned fingerprint and answers the POST with 405 |
| `cloudflare/test/producer/infra-collector.test.ts` | 2 s deadline on a hanging target, body cap, oldest-first counted overflow, one retry, `Retry-After` cap, protocol rejections, shutdown deadline; Stats responses byte-identical with the collector stopped |
| `deploy/orange/metrics.test.mts` | Native two-Worker INF-2 build reads back both Worker identities and the Engine; a Worker 1 restart is a reset gap; after rollback the Engine shows no alarm retries for the metric actor |

## First slice

The first slice parses and stores real scrapes offline: catalog v1, exposition parser, batch
codec, `MetricStore` core on `node:sqlite` and the sources summary, with no route, actor or
collector process. Inputs are both Worker scrapes from INF-2's two-Worker
`tests/orange-serve.test.ts`, a capture after Worker 1 restarts, and one native rehearsal Engine
scrape. Acceptance is one command, through a new `test:metrics` script that runs
`node scripts/run-tests.mjs --file test/metrics`:

```sh
pnpm --dir cloudflare -s test:metrics
```

## Owner decisions

1. Infrastructure metrics sit outside the logical backup contract, so a restore leaves a gap.
2. Docker Lisa reachability: the collector joins the app container's network namespace, INF-2
   adds a configurable bind address, or metrics run on native hosts only until native Lisa.
3. The reserved `stats-infra` name and credential, and Stuff ownership of the collector unit.
4. Failed scrapes count as `drops`, or a `stats-release-evidence/2` field carries them.
5. Engine resets rely on counter decreases, or INF-11 adds an Engine start-time gauge.
6. Ratification of catalog v1 from the first real scrape; no registration-failure family exists.

## Unverified assumptions

- Captures confirm the `rivet_rivetkit_` and `rivet_` prefixes and the Worker identity
  labels. The v1 catalog includes only observed families and closed observed label values.
  No captured family establishes registration failures, alarm delivery retries, Engine
  object-store or namespace retries, or lease degradation; these remain gaps. Heartbeat
  reads and stale alarm deliveries are present and admitted.
  Families and label values absent from the captures require new evidence before admission.
- OpenOrange may reject a new SQLite class under the generated `v1` migration tag
  (`generate.mts:77`). An Engine holding actors whose class the runner lacks may not stay quiet.
- The cost of a scrape on the Worker event loop is unmeasured. STA-128 thresholds apply before
  production enablement.

## Rulings (2026-11-20)

- Metrics stay outside the logical backup contract. They are rebuildable
  telemetry; a restore leaves a gap, which reads as missing data.
- Collection starts on native hosts, where the Stats writer runs. Docker Lisa
  reachability waits until native failback or an INF-2 bind-address option.
- The `stats-infra` credential is reserved like `stats-platform`. Failed
  scrapes count as drops. The allowlist admits a family only after a captured
  real scrape contains it.
- The raw scrape cap is 4 MiB. The production Engine exposed 1,421,880 bytes;
  the active rehearsal Engine exposed 1,175,390 bytes. The collector filters
  lines while streaming and aborts larger bodies as `too_large`. The batch cap
  remains 64 KiB. The 64 MiB cgroup probe is recorded under retention and budgets.
