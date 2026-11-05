# Architecture

A Rust agent, static musl on Linux and native on macOS (`agent/src/linux.rs`,
`agent/src/macos.rs`), samples each host and posts binary STB2 batches over HTTPS
to a Cloudflare Worker. The Worker forwards ingest and API calls to one
SQLite-backed Durable Object, which stores raw samples and rollups and answers
history queries. A five-minute cron on the same Worker also reads Cloudflare's own analytics for
configured projects, such as a Worker and its R2 buckets. A Solid dashboard,
served through the same Worker, reads that API behind Cloudflare Access. The wire contract between agent and Worker is in
[`protocol.md`](protocol.md). The same core also runs as a Node server
(`cloudflare/src/node/`) for a tailnet-only instance; see [Node server](#node-server).

## Source layout

`cloudflare/src/` is split into a portable core and Cloudflare adapters.

- **Adapters** are `src/cloudflare/` and `src/observe/cloudflare/`. The first
  holds the stats Worker entry (`index.ts`, which wires Access, the Durable
  Object, assets, and the observe binding into the shared handler, and owns
  the scheduled handler), the `Installation` Durable Object wrapper
  (`installation.ts`), Access verification (`access.ts`), the Analytics
  collector and its row parsers (`projects/`), the Cloudflare API deployment
  collector (`deployments/`), and the `ctx.storage.sql`, clock, alarm, and
  operation-mark adapters for the core's ports. The second holds the
  `stats-observe` Worker, the `ObservationStore` Durable Object, the tail
  reducer, and the service policies.
- **Core** is everything else under `src/`. `src/core/installation/` is the
  host, history, project, and deployment logic, written against the ports in
  `src/core/sql.ts` (`SqlStatements`, the `SqlDatabase` that extends it, and
  `SqlScopes`) and `src/core/ports.ts` (`Clock`, `Scheduler`). The observation
  store takes the same `SqlStatements`. `src/core/http.ts` is the routing
  table both targets serve. `src/node/` implements the ports on `node:sqlite`
  and timers, and holds the Node server.

`test/node/boundary.test.ts` fails when any core file imports from an adapter
directory, `cloudflare:*`, or `@cloudflare/*`, so the core and `src/node/`
load in plain Node.

## Agent

`agent/src/main.rs` parses the command line, `config.rs` loads and validates
the config and token, `linux.rs` samples, `runtime.rs` runs the sampling and
upload threads, `queue.rs` holds unsent samples, `wire.rs` encodes STB2
request frames and decodes STA2 acknowledgments, and `transport.rs` posts with
`h12tiny-client-sync` and Rustls (Graviola) against the system trust roots.
Samples hold native integers (`model.rs`): counters as `u64`, load averages
as thousandths, PSI averages as hundredths. The JSON form exists only for
`--once` and the fixture sources. The runtime asks the transport to prepare a
batch, which encodes the samples once in order and keeps the longest prefix
that fits 65,536 bytes; the samples after it go back to the front of the
queue in order and start the next frame.

A failed upload is logged to stderr with its class and message, rate-limited to
one line a minute while it repeats. A 401 or 403 keeps the batch, backs off at
the 60 s cap, and rereads the token file before each retry; a token rotation
needs only a file replace. Agent-side drops are counted separately from
rejections the server reports.

Sampling sources and filters:

- CPU from the `/proc/stat` aggregate; no per-core series.
- Memory from `/proc/meminfo` `MemAvailable`; swap activity from the
  `pswpin` and `pswpout` counters in `/proc/vmstat`, converted to bytes; load, uptime, and CPU count from
  `sysinfo(2)`.
- Disks from `/proc/diskstats`, whole devices listed in `/sys/block`,
  excluding `loop*`, `ram*`, `zram*`, and `fd*`.
- Network from `/sys/class/net/<if>/statistics` 64-bit counters, excluding
  `lo` and, unless `includeVirtualInterfaces` is set, every interface without
  a sysfs `device` link (veth, bridges, tunnels). Sysfs exposes the same `rtnl_link_stats64` counters as rtnetlink
  without hand-built netlink packets or an async netlink crate.
- PSI from `/proc/pressure/{cpu,memory,io}`, kept separate from iowait.
- Filesystems from `/proc/self/mounts` plus `statfs(2)`, one entry per block
  device (the shortest mount path wins, so bind mounts and btrfs subvolumes are
  not repeated), limited to the
  allow-list in `agent/src/parse.rs`, at most 16. `tmpfs` and `overlay` mounts
  are skipped unless `includeVirtualFilesystems` is set.

Procfs files are reopened each sample into bounded buffers. The baseline agent
has no per-process polling, async runtime, BPF, web server, or dynamic
libraries.

`seq` is `floor(monoMs / 1000)` and the boot id comes from the kernel, so a
process restart within a boot continues the sequence without a state file.
`sampleIntervalMs` has a 15,000 ms minimum, which matches the raw history step
and keeps `seq` unique.

## Worker

`handleStatsRequest` in `cloudflare/src/core/http.ts` is the whole routing
table; `cloudflare/src/cloudflare/index.ts` calls it with Access as the auth
decision, the Durable Object as the `Installation` transport, the `ASSETS`
binding, and the `OBSERVE` service. `/health` is public.
`POST /ingest/v2/batches` with a token-shaped bearer, the STB2 media type, no
content encoding, and a declared length within the cap is forwarded to the
Durable Object unread; the object reads the body as bounded bytes, decodes it
(`src/ingest/frame.ts`), authenticates the host bearer token, validates each
sample and normalizes it to the stored JSON shape (`src/ingest/sample.ts`),
and answers with an STA2 acknowledgment (`src/ingest/ack.ts`). Any request to
the retired `/ingest/v1/batches` answers `410 Gone`.

Every other path that serves assets or data first passes the target's auth
decision, which on the Worker is `verifyAccess` in `src/cloudflare/access.ts`. Assets run through the Worker
(`assets.run_worker_first`), so a cache hit cannot bypass authorization.
Methods other than GET and HEAD on non-API paths are rejected before routing.
`/api/observe/<service>/*` passes the same Access check and is then proxied
over the `OBSERVE` service binding to `stats-observe`, the observability
collector in `docs/observability-campaign.md`. The only writes it passes are
an issue's resolve or reopen and a source-map upload, and both must be
same-origin. That Worker is the tail consumer of every observed service
(`stats`, `usr-memories`, and `nanoshop-storied`, listed in
`src/observe/services.ts`), has no
route of its own, and keeps each service's data in its own
`ObservationStore` Durable Object named after the service. It routes each
tail event by the producer's script name; each service's route templates
and closed set of error operations live in `src/observe/cloudflare/policies.ts`,
and an event from any other script is dropped with a fixed log line.
`nanoshop-storied` generates its templates from exported route data in
Nanoshop's own notation (`/products/{handle}` becomes `/products/:handle`);
`/static`, `/assets`, and unmatched paths are excluded, and its storefront
object has no public route. An unrouted Worker request that carries an
uncaught exception, a channel error report, or a status of at least 500 is
not excluded: it is observed as `<METHOD> unmatched`. Each service's
`operation` channel message is read by that service's decoder: stats' typed
summaries, or a generic `{operation, synthetic, rows}` message for the
others. Each policy also names a sampling mode: `stats` and `usr-memories` keep
every observed invocation (`{ kind: "all" }`), and `nanoshop-storied` is
`sampled` with a keep rate in parts per million and slow-wall and slow-CPU
thresholds. Its thresholds sit well above Nanoshop's documented request
latency, which has a local p99 under 20 ms, and above its 2 to 5 ms CPU
assumption, so only abnormal invocations are kept for being slow; the rate is
provisional until the cost budget sets it. After
each deployment poll, the scheduled handler forwards every observed
project's stored deployments and version tags to its service as rollouts
over the same binding.

The observability code under `cloudflare/src/observe/` is layered so only
one folder knows about Cloudflare. `core/` holds the model, grouping, SQL
store, and `service.ts`, which implements every API operation over any
`SqlStatements` database and a clock. `http/api.ts` turns Web-standard requests into
service calls. `client/` holds the response decoders and the `pnpm observe`
CLI, and `producer/` the diagnostics-channel contract that application code
reports through. `cloudflare/` holds the adapters: the `stats-observe`
Worker entry, the `ObservationStore` Durable Object, the tail reducer, the
deployment-to-rollout mapping, and the trace-context mark. `observe.tsconfig.json`
typechecks everything outside `cloudflare/` without Workers types, so a
Cloudflare dependency there fails the build.
`cloudflare/public/llms.txt` is an ordinary asset, so it passes Access too; it
tells an agent how to authenticate and read the API. A Vite plugin in
`cloudflare/vite.config.ts` copies `docs/protocol.md` and `docs/architecture.md`
into the assets as `/docs/protocol.md` and `/docs/architecture.md`, the two
files `llms.txt` links to; no other doc is served.

Routes under `/api/v1/` (handled in `src/core/installation/installation.ts`):

- `GET /hosts`, `GET /hosts/:hostId/latest`, `GET /hosts/:hostId/system`
  (404 until the agent has reported).
- `GET /hosts/:hostId/history?range=1h|6h|24h|7d|30d&kind=summary|disks|nets|filesystems|block`.
  Pass `from` and `to` (epoch milliseconds, at most 30 days apart) instead of
  `range` for an explicit window; the response then omits `range`. Pass
  `kinds=summary,disks,nets` instead of `kind` to receive several kinds at once
  as a bundle.
- `GET /projects` and `GET /projects/:id/history?range=1h|6h|24h|7d|30d&kind=worker|routes|durable-objects|r2|d1|d1-statements|probes|collector`. `from=<ms>&to=<ms>` replaces `range` (both, `from` before now, at most 30 days apart); a windowed frame carries no `range`. The bucket width is the smallest that gives at most 900 points for the span, except that a window starting before the fine samples' 7-day retention is served from hourly rows.
  Pass `kinds=worker,r2,collector` instead of `kind` to receive several
  kinds at once as a bundle (see [Cloudflare projects](#cloudflare-projects)).
  Both history routes answer in the [history frame](#history-frames); every
  other route and every error answers in JSON.
- `POST /admin/hosts`, `GET /admin/hosts`, `POST /admin/hosts/:hostId/rotate`,
  `DELETE /admin/hosts/:hostId` (revoke), `DELETE /admin/hosts/:hostId/purge`.
- `POST /admin/services`, `GET /services`, `GET /services/:name`,
  and `GET /services/:name/deployments`; the marker `POST` is
  `/ingest/services/:name/deployments` (see [Services and deploy markers](#services-and-deploy-markers)),
  and `GET /services/:name/deployments/:id/comparison?window=1h|6h|24h`
  (see [Service comparison](#service-comparison)).

Two authorization boundaries:

- **Humans** carry `Cf-Access-Jwt-Assertion`. The Worker verifies the RS256
  signature against the team JWKS (cached one hour), plus issuer, audience,
  expiry, and not-before with 60 s leeway. Edge Access alone is not trusted.
  Any valid Access identity may use the admin routes, so the Access policy is
  the owner allow-list. `ACCESS_JWKS_JSON` is honored only when
  `ENVIRONMENT=test`.
- **Hosts** send `Bearer nft_<43 base64url chars>`: 32 random bytes, stored only
  as a SHA-256 verifier, compared in constant time, bound to one host id, and
  individually rotatable and revocable. Rotating a revoked host clears the
  revocation.
- **Deploy scripts** send a service's deploy token, in the same format and
  stored the same way, only to `POST /ingest/services/:name/deployments`.
  That route never checks Access or Tailscale identity, like ingest.

Revocation keeps the host row, verifier, and telemetry, so history stays
readable. Purge deletes the host row, raw samples, and rollups in one
transaction.

Responses carry a self-only CSP, `frame-ancestors 'none'`, `nosniff`, and
`no-referrer` (`SECURITY` in `index.ts`). `workers_dev` and preview URLs are
disabled in `cloudflare.config.ts`, so no alternate hostname exists.

Ingest rejections other than duplicates, alarm failures, and the 500 catch-all
write a fixed JSON line to Workers Logs (`event`, `hostId` when known, and
`code`). `cloudflare.config.ts` enables Workers Logs at 10% head sampling.

Configuration: `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are Worker secrets;
`ENVIRONMENT`, `INSTALLATION`, `ASSETS`, `ANALYTICS_SQL`, and `PROJECTS` are
bindings declared in `cloudflare.config.ts`, which also declares the cron. The Durable Object id is the fixed name `installation`.

### Operations and coverage

Measuring whether a deployment used fewer resources needs counts of work, not
only of requests. Each instrumented `stats` invocation publishes one
`operation` message on the `stats.observe` diagnostics channel instead of the
bare `invocation` mark (`src/operations.ts`, `src/observe/producer/channel.ts`).
It names an operation id (`host.ingest`, `host.history`, `project.history`,
`collector.record`, `cleanup.retention`, `deployments.poll`), whether the host
was the synthetic check, the invocation's SQLite row account, and the work that
operation did: persisted, duplicate and rejected samples and input bytes for
ingest; points, cells, output bytes and cache result for history (with a
`workloadClass` such as `1m:summary`); successful runs, metric rows, hour rollups and
upstream queries for the collector; expired rows and backlog for retention.
Retention's `expired` is the sum of `rowsWritten` deltas of its delete
statements, so it includes index rows, and `backlog` counts categories; neither
is a logical row count, and `statsctl verify` does not accept
`cleanup.retention`.
`stats-observe` must accept `operation` before `stats` emits it. A tail that
does not know the kind rejects the whole invocation as `rejected-invalid`, so
never roll `stats-observe` back below the version that accepts `operation`
while `stats` emits it.

`SqlAccount` (`src/sql-account.ts`) wraps `SqlStorage.exec`. It adds each
cursor's `rowsRead`, `rowsWritten` and one statement to its totals once the
cursor is consumed or closed, so the account counts what SQLite actually
read and wrote, not what the code expected.

The `ObservationStore` keeps two additive tables beside its existing ones, both
in five-minute buckets and bounded to 100,000 rows:

- `observe_operations`, keyed by `(bucket_at, version, operation,
  workload_class, synthetic)`. Each row holds `count`, `failed`, summed
  `cpu_ms_sum`, `wall_ms_sum`, `rows_read`, `rows_written` and `statements`,
  lag counters (`lag_count`, `lag_ms_max`, `lag_ms_sum`), and one integer column
  per work field. Synthetic rows are kept apart from real ones.
- `observe_outcomes`, keyed by `(bucket_at, version, stage, outcome, route)`.
  It counts tail events that produced no stored invocation, by `stage`
  (`worker`, `object`, `unknown`) and by `outcome`: `excluded-status:401|403|404`,
  `excluded-route`, `rejected-invalid`, `unknown-service`. Each bucket, version,
  stage and outcome keeps at most 32 routes, then folds the rest into one `other` route. Each row
  records the `filter_revision` that excluded it.

A third additive table, `observe_counts`, is written only for a service whose
policy samples. It holds one row per five-minute event-time bucket, so a flush
writes one row per bucket it touches however many keys it carries, and
retention deletes one row per bucket. The row's `entries` column is a JSON array
with one element per `(version, stage, outcome, route, operation)` key holding
`kept`, `sampledOut`, `capped`, `cpuMsSum` and `wallMsSum` (`capped` is part
of `sampledOut`; entries written before it existed read as 0), merged in the store
transaction; the `untraced` and `flushes` columns count the sampling events of
the calls that wrote the row. The view `observe_count_entries` presents the
elements as rows for reads. An element's `outcome` is `ok`, `failed`,
or one of the four `excluded-*` classes; the operation is the generic operation
name that stats-style summaries do not carry, empty when an event has none. The
store counts a kept invocation in the same transaction that stores it, so a
duplicate is never counted twice. The tail counts everything it does not keep
(a sampled-out invocation is always `ok`, because every failure is kept, and an
excluded event is never kept) and sends those counts with the batch. Each
bucket, version, stage and outcome keeps at most 32 routes, then folds the rest
into `other`. For a sampled service the window's invocation rows and its
excluded outcome rows come from this table, so they total every event, kept or
not. The table has no row for a service that keeps everything, so `stats` and
`usr-memories` write and answer exactly as before.

A sampled-out event costs no store request of its own. The tail Worker counts
each sampled service's sampled-out and excluded events in a per-isolate buffer
(`src/observe/core/count-buffer.ts`) keyed like `observe_counts`, and sends the
buffer to the service's store in one call when it is older than
`COUNT_FLUSH_INTERVAL_MS` (the five-minute bucket width) or its oldest count falls in an earlier
five-minute bucket than the event now arriving. If the event that finds the
buffer due has invocations or outcomes of its own, the buffer rides on that
call; otherwise it goes alone. A kept event that finds a young buffer writes
only itself. Cloudflare cancels `ctx.waitUntil` work that has not settled 30
seconds after the invocation ends
(<https://developers.cloudflare.com/workers/runtime-apis/context/>, read
2026-11-04), so an idle isolate cannot sleep a whole flush interval there. Instead
each batch that buffers counts arms a timer through `ctx.waitUntil` unless a
timer armed within the last 10 seconds already covers it; the timer sleeps
`IDLE_FLUSH_MS` (20 s) and flushes only if no batch has added counts for 10
seconds. Counts left in an isolate that receives no further event are therefore
flushed within 20 s of the last batch, and a busy isolate flushes by the interval
rule above. Each flush adds one to the bucket row's `flushes` column.

Counts are exact for every event that reaches the collector and is flushed.
A flush is at most once: the buffer is emptied before the store call, so a
failed call loses what it carried, and the failure is logged or thrown. An
isolate that is evicted, or that never gets its timer, loses at most one flush
interval of sampled-out and excluded counts. Kept invocations are never lost this
way, because the store counts them in the transaction that stores them. The loss
shows as coverage below `reconciled` against analytics `worker.invocations`.
Exactness across eviction would take one durable write per event, which is the
cost buffering removes; the owner accepted that trade. A service that keeps
everything is not buffered.

A sampled service also caps its always-kept invocations. `keepReason` keeps
errors, status 500 and above, non-ok outcomes, slow events and untraced events
whatever `keepPerMillion` says, and each costs a store request and up to 12 rows.
The tail isolate admits at most `ALWAYS_KEPT_PER_BUCKET` (10) of them per service
per five-minute count bucket (`AlwaysKeptCap`, module state next to the count
buffer in `cloudflare/worker.ts`). Past the cap an invocation is not stored: it
is counted like a sampled-out one, with its real outcome class, so `failed`
totals stay exact, and its `capped` count rises. Trace-hash keeps, invocations
rejected as invalid, and services that keep everything are never capped. The cap
is per isolate, so the bound scales with the number of tail isolates: the
ceiling is `isolates x 10` always-kept invocations per bucket, priced in
`observe-billing.md`. Detail beyond the cap is lost, so a deploy that fails every
request keeps ten stored failures per isolate per bucket and counts the rest.

Sampling relies on each invocation's tail event carrying exactly one `operation`
message. In local workerd, when RPCs overlap on one Durable Object instance
(even two at a time), diagnostics-channel messages land on other invocations'
tail events: 200 sequential RPCs each carried one message, but 200 RPCs five
at a time produced events carrying zero to four, and RPCs on distinct
instances were unaffected. An object event with no message has no trace, so it
is kept and counted `untraced`; one with two operation messages is rejected as
`rejected-invalid`. Worker events were unaffected. Whether production behaves
the same is unverified.

For a sampled service, health adds a `sampling` object: the policy, and over
the retained days, the invocations `kept`, the ok or capped failed invocations `sampledOut`, the
`excluded` events, the `untraced` invocations, the count `flushes` (batches
that carried counts), and `capped`, the always-kept invocations counted instead
of stored (a subset of `sampledOut`). The window, explore, objects, traces, trace and rollout
impact responses add `sampling: { keepPerMillion, kept, observed }`, where
`observed` is exact and counts kept plus sampled-out ok and failed invocations
of the response's stage over the whole buckets it overlaps. Explore routes add an
exact `observed` count, and a rollout's request and failure counts come from the
counts table. Every percentile and the CPU share in those responses are computed
from the kept invocations only: `statsctl observe --project nanoshop-storied` and
the dashboard label them sampled, and a service that keeps everything returns
none of these fields.

`GET /api/observe/stats/window?from=<ms>&to=<ms>[&operation=<id>][&class=<name>]`
returns one half-open window: operation rows, outcome rows, invocation rows and
lag totals, with `filterRevision` and `bucketMs`. It is read-only and passes
the same Access check as every observe route.

The coverage rule (`src/compare/coverage.ts`) decides whether the observed
counts can support a verdict. For each side of a comparison it sums the
invocations plus every outcome class the tail saw, per five-minute event-time
bucket, at the `worker` stage only, because the analytics source counts only
stateless Worker events. It compares that sum with the analytics
`worker.invocations` the comparison route returns in `analyticsInvocations`.

That analytics source is Workers Logs, which the stats Worker samples at
`headSamplingRate: 0.1`. At stats' traffic of about 22 Worker invocations per
bucket, each bucket rests on about two sampled events. So a bucket missing from
analytics means that no event was sampled, and it counts as zero. The bound is
the larger of 5% of the analytics total and three standard errors of the
sampled estimate, `3 × sqrt(observed × (1 − p) / p)`. For one hour of stats
traffic that is about ±50%, so coverage catches gross loss, not a few percent.

The state is:

- `reconciled` when no observed bucket is missing and the totals differ by at
  most the bound;
- `partial` otherwise;
- `unknown` when either source lacks the window.

A comparison is `reconciled` only if both sides are. On 2026-11-05 from 06:05
to 06:50 UTC, 246 Worker events were observed against an analytics estimate of
220: a spread of 11.8%, inside a bound of 64%.

## Node server

`cloudflare/src/node/main.ts` serves the same `handleStatsRequest` over
`node:http`, so every supported route answers with the same status, headers,
and body bytes as the Worker; `test/node/http-parity.test.ts` checks health,
ingest, host, history (including `304`), project, and rejection routes
against the built Worker in workerd. It differs from the Worker only in what
it plugs into the handler:

- **Storage.** One `InstallationCore` on a `node:sqlite` file,
  `$STATS_DATA_DIR/stats.sqlite`. One process owns the file, which gives the
  single-writer guarantee the Durable Object gives. Retention runs on the
  timer scheduler.
- **Auth.** `src/node/tailscale.ts`. A non-ingest, non-health request is
  accepted only when the TCP peer is loopback (or the connection is on the
  Unix socket named by `STATS_LISTEN`, which has no TCP peer and is
  reachable only through filesystem permissions) and its `Tailscale-User-Login`
  header is in `STATS_ALLOWED_LOGINS`; otherwise it gets `401 unauthorized`
  before any data is read. The server is meant to sit behind
  `tailscale serve`, which sets that header for tailnet users. Ingest ignores
  Tailscale headers and requires the host bearer token, as on the Worker.
  On both targets a non-GET, non-HEAD, non-OPTIONS `/api/v1` request is
  rejected with `403 forbidden` when its `Origin` is not its own origin or
  its `Sec-Fetch-Site` is `cross-site`; the Node server derives its own origin
  from `Host` and `X-Forwarded-Proto`.
- **Assets.** `src/node/assets.ts` serves the Vite output in
  `cloudflare/.cloudflare/output/v0/workers/default/assets`, with `/` as
  `index.html` and no path outside that directory.
- **Encoding.** workerd compresses a body whose `Content-Encoding` the handler
  sets; the Node writer compresses negotiated history frames with `zlib`.

Features that read Cloudflare are off. The project registry is empty, so
`/api/v1/projects` is `[]`, project history and deployment routes answer
`404 not_found` as the Worker does for an unregistered project, and the
dashboard shows no projects. `/api/observe/*` answers
`503 {"error":{"code":"unavailable"}}` after auth. No cron runs.

## Services and deploy markers

A service is a named set of agent hosts that deploy scripts report releases
for. Services are rows in the Installation database, created through the admin
API on either target, so adding one needs no redeploy. The code is
`src/core/installation/services.ts`, and both targets reach it through
`handleStatsRequest` in `src/core/http.ts`.

`POST /api/v1/admin/services` takes `{ name, hostIds, healthUrl?, unit? }`
as `application/json`, at most 8 KiB, and needs the target's human auth:

| Field | Rule |
| --- | --- |
| `name` | The project id charset: `^[a-z][a-z0-9-]{0,31}$`. A taken name answers `409 conflict`. |
| `hostIds` | 1 to 64 distinct ids of existing, non-revoked hosts, stored sorted. |
| `healthUrl` | Optional. `https:`, or `http:` on a host ending in `.ts.net`, with no credentials or fragment, at most 2048 characters. |
| `unit` | Optional. A systemd unit or container name: `^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$`. |

It answers `201` with the service and a new deploy `token`. The token is in
that response only. The server keeps its SHA-256 verifier in
`services.token_hash`, and the token cannot be read back or rotated in this
version. `GET /api/v1/services` answers `{ "services": [...] }`, and
`GET /api/v1/services/:name` answers one service; neither carries the token.

`POST /ingest/services/:name/deployments` records a deploy marker. Its only
credential is `Authorization: Bearer <deploy token>`. It skips Access and
Tailscale identity, so a CI runner or a deploy script on any host can reach it,
as an agent reaches ingest. It lives under `/ingest/` because Access matches
applications by path, not method: the zone's `/ingest/*` Bypass lets the
marker through, while `GET /api/v1/services/:name/deployments` stays behind
Access. A `POST` to that `/api/v1` path answers `405`. Rejections, all before
any write:

| Check | Answer |
| --- | --- |
| No bearer token in the token format | `401 unauthorized` |
| `Origin` or `Sec-Fetch-Site` names another site | `403 forbidden` |
| `Content-Type` is not `application/json` | `415 unsupported_media_type` |
| Body over 8 KiB, declared or streamed | `413 too_large` |
| Unknown service, or a token that is not the service's | `401 unauthorized`; the two are indistinguishable |
| Bad JSON, an unknown key, or a field outside its rule | `400 invalid_request` |
| A host outside the service, or unknown or revoked | `400 invalid_request` |

The body is `{ markerId, version, message?, hostIds }`:

- `markerId` is the client's idempotency key, `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`.
- `version` is what was deployed, `^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$`, such as a commit or a semver.
- `message` is at most 1000 characters; control characters become spaces, as Cloudflare deployment messages do.
- `hostIds` is a non-empty subset of the service's hosts.

A new marker answers `201` with
`{ service, markerId, hostIds, deployment }`. `deployment` is a `Deployment`
from `src/deployments/model.ts`:

- `id` is a UUID derived from SHA-256 of the service name and `markerId`;
- `atMs` is the server receive time;
- `source` is `"marker"`;
- `versions` is `[{ id: version, percentage: 100 }]`;
- `deferred` is `false`.

A marker is unique on `(service, markerId)`. A repeat with the same
`version`, `message`, and set of hosts answers `200` with the stored marker,
its original `atMs` included. A repeat that differs in any of them answers
`409 conflict` and changes nothing. A deploy script can therefore retry a
marker safely.

`GET /api/v1/services/:name/deployments` answers the project deployments
route's `DeploymentHistory` shape. `projectId` and `worker` are the service
name, `enabled` is `true`, `sync` is `null`, and `versions` is `[]`. The added
`markers` array maps each deployment id to its `markerId` and `hostIds`.
Deployments are newest first, at most 1000 from the last 30 days. Ties at the
same millisecond list the later-recorded first. The alarm deletes markers
older than 30 days in batches of 1000.

`decodeDeploymentHistory` in `src/deployments/decode.ts` requires UUID
version ids, so service histories go through
`decodeServiceDeploymentHistory` in `src/deployments/service-decode.ts`, which
accepts marker versions such as a commit.

### Service comparison

`GET /api/v1/services/:name/deployments/:id/comparison?window=1h|6h|24h`
(default `1h`) compares one marker with the marker before it, with the project
comparison's windows, settling, and baseline rules. `gateDeployment` in
`src/deployments/compare.ts` is the shared part: the before window ends at the
bucket the marker landed in, the after window starts one full bucket later, and
a marker with no earlier marker at least one window before it, a split or
overlapping deploy, or an after window not yet settled withholds a verdict
with a reason code. The service settle time is 15 minutes
(`SERVICE_SETTLE_MS`), because agents report continuously and no collector has
to catch up. `compareServiceDeployment` in
`src/deployments/service-compare.ts` supplies the metrics. The response is a
project `DeploymentComparison` (invocation counts are `null` and
`analyticsInvocations` is empty) plus:

- `hostIds`, the hosts named in the marker, which are the hosts compared;
- `sources`, `[{ source: "hosts" | "cgroup" | "probe", status: "available" | "unavailable", detail }]`,
  always in that order; an available `cgroup` names the metrics it supplied.

Metrics are levels, each the mean of five-minute buckets in the window, and a
bucket counts only when every compared host reported at least 150 s of it:

| Metric | Source |
| --- | --- |
| `host.cpu` (user + system, %), `host.memory` (used, %) | host one-minute rollups |
| `host.pressure.cpu`, `.memory`, `.io` (PSI some, 60 s average, %) | host one-minute rollups |
| `host.net` (rx + tx excluding `lo`, B/s), `host.disk` (read + write, B/s) | host one-minute rollups |
| `service.cpu` (cores), `service.memory` (`memory.current`, B), `service.io` (read + write, B/s) | the service's cgroup in host one-minute rollups, from agents configured with the service |
| `probe.health.ms`, `probe.health.failure` (%) | service health probes, only when `healthUrl` is set |

A cgroup metric replaces its host counterpart (`service.cpu` for `host.cpu`,
`service.memory` for `host.memory`, `service.io` for `host.disk`) only when it
has a value in both windows; otherwise the host metric stays and the cgroup
metric is left out, so an agent rolled out between the windows never yields a
cgroup comparison against nothing. A cgroup bucket also needs 150 s of cgroup
counter coverage. Network and pressure have no cgroup counterpart and stay
host-level.

Hosts are averaged, so a host that has no bucket makes that bucket absent. A
window needs 75% of its buckets, as probe metrics do for projects. A metric
with no value in a window is `null`, never zero, and its verdict is
`insufficient-data`. When no metric has a value on both sides, the comparison
carries the reason code `no-data`. The warnings always include that the
comparison shows resource levels, not fewer resources for the same work,
because a service does not report its own work counts, and that host metrics
include every process on the host (and, when cgroup metrics were used, that
those cover only the service's unit).

Probes on the Node target run on the scheduler port every five minutes, on the
bucket boundary (`src/node/probes.ts`), with `runProbes` from
`src/projects/probes.ts`. `InstallationCore.collectServiceProbes` writes
`probe.health.up` and `probe.health.ms` to `project_samples` under the owner
`service:<name>`, which cannot collide with a project id. The Worker target
runs no service probes, so a service's probe source is `unavailable` there.

## Storage and rollups

One Durable Object per installation holds the host tables below and the project
tables in [Cloudflare projects](#cloudflare-projects), created with
`CREATE TABLE IF NOT EXISTS` in `src/core/installation/schema.ts`:

- `hosts`: credentials, revocation, last receipt, and the rate-limit window.
- `host_history_versions`: a per-host version advanced by ingest and retention,
  used for history ETags.
- `host_system`: the latest `system` object per host and when it arrived.
- `samples`: raw samples for 48 hours, unique on `(hostId, bootId, seq)`. The
  payload is the sample's canonical JSON (decimal-string counters, sorted
  keys), the same text the v1 JSON protocol stored; the binary ingest format
  does not reach storage, and duplicates compare this text.
- `rollups`: keyed by `(hostId, resolution, bucket)`; one-minute buckets for
  7 days and hourly buckets for 30 days.
- `services`: one row per service, with its deploy token verifier and its
  host ids as a sorted JSON array (schema version 8).
- `service_deployments`: deploy markers keyed by `(service, markerId)`, with
  the `Deployment` JSON and the marker's host ids, for 30 days.

Rollups store counter delta sums with the interval each device covered and
gauge sums with counts; they never average counters. A device rate divides by
its own covered interval, so a missing sample is a gap rather than a lower
rate; swap in and out sums carry their own covered interval the same way, and GPU energy carries the interval it covers. GPU residency and system power readings sum as plain deltas. Block histograms sum bucket counts and totals and keep the observed
minimum and maximum; percentiles come from bucket upper bounds and are not
exact. A service's cgroup counters (`services` in a sample) roll up per service
name: `cpuUsec` and the io byte sums each carry the interval they covered, and
`memoryCurrent` is a gauge; a payload with no service reading has no
`services` key, so host-only rollups are unchanged. A late sample rebuilds its minute, the minute
of the following sample, and every hour those minutes fall in. A bucket with
less than 80% of its span covered by usable intervals is marked partial.

A Durable Object alarm deletes expired rows in batches of 1000 per tier. It
never repairs or invents data.

History picks raw when the window starts within 48 hours and spans at most 12
hours, one-minute rollups within 7 days, and hourly rollups beyond, so a zoomed
window reads finer data than the preset range it came from. Windows longer than
12 hours use one-minute rollups even inside the raw retention, because raw
sampling would be downsampled to about the same resolution after the 900-point
cap. Results are downsampled to at most 900 points and carry a `stepMs`, with
fractions rounded to three decimals.

A preset range ends at the current 15-second raw step. While the Durable
Object stays alive it keeps each host's raw rows as computed chart points,
parsing a sample once and afterwards reading only rows past the highest
`rowid` it has seen, at most 16,000 rows across hosts with the least recently
read host dropped first. A late sample, which rewrites the next sample's delta,
drops its host's rows; a purge and an alarm that deleted rows drop all of
them, so the next read parses its window again. On top of that it keeps the
last four windows it served, keyed by the host's history version, and builds a
window's kinds as they are asked for, as typed columns rather than point
objects; a request serializes those columns, and the frame is not cached. The dashboard asks for all five kinds in
one batched history request on each refresh. Summary points carry `cpuCount` and
`uptimeMs`; the dashboard reads a fall in uptime as a reboot.

History responses carry an `ETag` derived from the last host ingest or the last
collector run, plus the requested window and kinds and the frame format
(`:stc1`), so a validator never matches a different representation. The match
is weak, so a `W/` prefix added by an intermediary still revalidates. The
dashboard sends `If-None-Match` and reuses its decoded history on `304`, so a
poll that finds no new source data returns before building history. The `304`
carries `ETag` and `Vary: Accept-Encoding`, never `Content-Encoding`.

### History frames

A history response is one binary frame with content type
`application/vnd.stats.history.v1`: a 16-byte header, a bounded JSON
descriptor, then little-endian numeric columns. Cloudflare's edge does not
compress custom content types, so the Worker compresses the frame itself: it
sets `Content-Encoding` to `br` when the request's `Accept-Encoding` allows it
(quality above zero, `*` included), else `gzip`, else leaves the body as is, and
adds `Vary: Accept-Encoding` to every `200` and `304` on a history route. The
Worker hands the runtime an uncompressed body with the header and the runtime
compresses on the wire (`encodeBody: "automatic"`, the default). Errors on
these routes stay uncompressed JSON. The security headers and
`Cache-Control: no-store` apply as to every API response.

Header: ASCII `STC1`; version `1` and flags `0` (u16 each); descriptor length
and total frame length (u32 each). The descriptor is
`{metadata, tables: [{name, rows, columns}]}`; a column is `{name, type,
nullable}` with `type` `f64`, `u64`, or `u8`, or `{name, type, ref}` when it
shares an earlier column's values (every kind of one host shares one `atMs`
axis where the axes match). Each table's data follows the descriptor, every
column padded to eight bytes: a validity bitmap (least-significant bit first,
set means present) when `nullable`, then the values, with zero in every absent
slot. An absent cell is missing, never zero. Unknown versions, flags, fields,
non-finite numbers, nonzero padding, and trailing bytes are rejected.

`metadata` is `{format: "stats-history", node}`. A node is one of:

- Host `summary`: `{form: "points", metadata, series: [{metadata: {}, table}]}`.
  `metadata` is `{hostId, range?, kind, fromMs, toMs, resolution, stepMs}`.
  Columns are the flattened point fields (`atMs`, `coverageMs`, `partial`,
  `cpu.user`, `mem.pressure.warnPct`, ...). An optional object such as `psi` or
  `cpu` is a `u8` presence column, 1 where present; its fields are `f64`
  columns present only where the object is. `partial` is `u8` 0 or 1. Field
  names are fixed per kind in `cloudflare/src/binary/history.ts`.
- Host `disks`, `nets`, `filesystems`, `block`: `{form: "series", metadata,
  series: [{metadata: {id, name?}, table}]}`, one table per device with its own
  `atMs`, so a device that appears or disappears has no cell for the rows it
  was absent.
- Project metric kinds: `{form: "metrics", metadata, table}` where `metadata`
  is `{projectId, range, kind, fromMs, toMs, stepMs}` and the table has one
  `f64` column per metric, named by the metric, row `i` at `fromMs + i *
  stepMs`.
- Project `collector`: `{form: "collector", value}` with the run list as JSON,
  since run details are text.
- A bundle: `{form: "bundle", metadata: {hostId} | {projectId}, entries:
  [{name, node}]}`, one entry per requested kind, in request order.

Floating-point values are exact binary64; host histories are rounded to three
decimals before they are written, as the JSON they replaced was. The dashboard
validates a whole frame once (`openHistory`) and reads columns directly; point
objects are never rebuilt. See [binary-history.md](binary-history.md) for limits,
measurements, and test coverage.

One object per installation keeps exactly-once storage and rollups in one
transactional store. Revisit it on measured per-object contention or the
Durable Object storage ceiling.

## Cloudflare projects

A project is one entry in the `PROJECTS` text binding: an id, a display name,
a Worker script, up to eight R2 bucket names, up to eight Durable Object
namespace ids, up to eight D1 database ids, and up to eight HTTPS probe URLs. `cloudflare.config.ts` writes the list and validates it when the config
is evaluated, so a bad entry fails `make worker-check`. `src/projects/config.ts`
validates it again on every use and rejects unknown keys, duplicate ids,
non-HTTPS probe URLs, and bucket names outside the R2 pattern; an invalid list
answers 503 with a fixed message. There is no create or update API.

**Collection.** The `scheduled` handler runs every five minutes. For each
project it reads the trailing 90 minutes through the `ANALYTICS_SQL` binding
with fixed queries (Worker events and per-route Worker events from
`logs.workersLogs`, Durable Object invocations when the project lists
namespaces, D1 queries and per-statement rows when it lists databases, R2
operations and storage when it lists buckets) and sends one GET
to each probe. The queries live in
`src/projects/queries.ts`, bind every value as a parameter, and take nothing
from a request. Worker, R2, and D1 events are `COUNT(*)` and unweighted
sums; only Durable Object invocations use `SUM(sampleInterval)`, whose weight is
1. At this account's volumes those datasets keep every event but stamp rows with
a `sampleInterval` that does not match what was kept, so weighting inflated
counts by the stamp. Measured 2026-11-01: 40 requests to `stats` (head sampling
0.1) left 40 rows weighted 10, and 200 requests to `stuff` (0.25) left 244 rows
weighted 4. For D1, unweighted rows written summed to 2.8M over six hours
against 682M weighted, and the database grew 190 MB, about 68 bytes per
unweighted row. R2 operations for `usr-memories` were 66k unweighted against
68k Worker events, but 668k weighted. If the platform starts sampling at higher
volumes, these counts become undercounts; re-run the checks above. History stored before the change is
inflated by that factor and ages out of the 90 minute rewrite window; Worker
and route counts recorded before the stateless-only change keep the broader
count, including the object's own fetch events, until retention. Every Worker
and route query keeps only stateless invocations, so a project's own Durable
Object fetch, RPC, and alarm events are excluded from those series and appear
only under Durable Objects. Everything is parsed before anything is
stored, so a failed run stores no metrics: it records a run with a fixed detail,
writes one `collector_failed` log line, and rethrows so the cron shows it.

**Storage** (schema version 7; version 5 dropped Worker, route, R2 operation, and D1
history before 2026-11-01 20:40 UTC, which was weighted by a mismatched
`sampleInterval`, version 6 dropped the collector runs before 22:10 UTC the
same day so those buckets read as unknown instead of zero, and version 7 added
per-host history versions for ETags):

- `project_samples(project, metric, bucket_ms, value)`: five-minute buckets for
  7 days.
- `project_hours(project, metric, hour_ms, value)`: hourly buckets for 30 days,
  rebuilt for each hour a changed value falls in; sums add, maxima take the
  maximum, and probe availability takes the minimum so an outage stays visible
  in wide buckets.
- `collector_runs`: the last 500 runs, with when each finished, whether it
  succeeded, rows read, and duration.

An upsert reads before it writes, so a run that returns the same values writes
no rows and late data replaces an earlier value. The existing alarm deletes
expired project rows in batches of 1000.

**Metrics.** Worker: `worker.invocations`, `worker.cpuMsSum`, `worker.cpuMsMax`
(approximate), and `worker.status.<class>`, counted over stateless invocations
only (the entrypoint's fetch and scheduled handlers, not Durable Objects). R2, per bucket:
`ops.success|userError|other`, `storageBytes`, `objects`. Probes:
`probe.<name>.up` and `.ms`, measured from Cloudflare's edge. Routes:
`route.<METHOD path>.invocations` and `.cpuMsSum` for the 15 routes with the
most CPU in the collected window. Path segments with a digit or over 24
characters become `:id`, a path level with more than 10 distinct children in
the window becomes `:*` (package names, content hashes), query strings are dropped, and keys are limited to 80
printable ASCII characters, so request paths cannot create unbounded series;
routes outside the top 15 are dropped, not pooled. Durable Objects, summed over
the project's namespaces: `do.invocations`, `do.errors` (status other than
success), `do.cpuMsSum`, `do.cpuMsMax` (approximate), `do.wallMsSum`. The
dataset reports no script name, so a namespace id is the only link to a
project, and it has no storage-size source. `do.storageBytes` is therefore
self-reported: on each successful collector run the Installation object reads
its own `ctx.storage.sql.databaseSize` and records it, in the run's bucket, for
every project whose `worker` is the `WORKER_NAME` binding. Other projects'
objects have no size. Worker CPU is
CPU time per invocation, not latency; the SQL source has no quantiles. R2
`userError` (mostly 404s) is shown but never scored.

D1, summed over the project's databases from `events.d1Queries`: `d1.queries`,
`d1.rowsRead`, `d1.rowsWritten`, plus `d1.<databaseId>.storageBytes` per database from
`states.d1Storage`, the largest size reported in each bucket. `d1q.<statement>.queries|rowsRead|rowsWritten`
cover the 10 statements with the highest billed cost in the collected window,
where a row written counts as 1000 rows read (the price ratio). The statement
is the first 160 characters of the query text with whitespace collapsed, cut to
60 printable ASCII characters; statements are written by the application and
use bound parameters, so request data does not create series. The dataset
reports every statement the database ran, so a backfill or a migration shows
up here as its own statements.

The project page opens with a cost ledger (`cloudflare/src/cost/ledger.ts`
builds it, `CostLedger.tsx` draws it). It prices collected usage at the list
prices in `cloudflare/src/cost/pricing.ts` and projects each line to 30 days.
The lines are Worker requests and CPU split by route; Durable Object requests
plus duration at 128 MB, split by method; D1 rows read and written split by
statement, plus D1 storage; and R2 storage per bucket. GB is 10^9 bytes, and
the plan's included allowances are not subtracted, so the ledger ranks where
spend comes from and is not a bill. Worker requests count the entrypoint only,
so an ingest is one Worker request and one Durable Object request.

The ledger reads its own two history windows. The current window is the last
hour ending at the last settled bucket, whatever range the page shows, so the
projection follows the current rate instead of averaging in an incident the
range still holds. A zoomed view replaces it with the zoomed window. The
previous window is the same length immediately before it. Each window is projected from the time
it actually covers, so a collector gap is not read as savings. A previous
window that starts after the history's retention has no baseline, and its
lines show no change.

Below the total, a chart shows what this UTC calendar month would be billed beyond
the Workers Paid plan's $5 fee: each meter (Worker requests and CPU, Durable Object
requests, GB-seconds, and storage, D1 rows read and written and storage, R2
storage) accrues from a third history window that starts at the month's first
instant, its plan allowance (`WORKERS_PAID_INCLUDED` in `pricing.ts`) is
subtracted, and the remainder is priced at list price. Storage accrues GB-months
for the time it was held. A dashed line extends every meter to the month's end at
the ledger's projected rate and applies the same allowances, so it bends where a
meter crosses its allowance. The allowances are account-wide, and the chart
assumes this project uses them alone.

Durable Object duration is billed per object while it is active, and
overlapping requests share one meter. Summed request wall time is therefore
an upper bound, and the ledger marks it with `≤`. For an observed service, the
per-method split comes from the observability store's `GET /objects`: summed
wall time, CPU, and call counts per object-stage label. The ledger attributes
the Durable Object total by each method's share. Where `do.storageBytes` was
recorded, the ledger prices it as SQLite storage at the list price per GB-month
and adds it to the Durable Object total. SQLite rows read and written have no
source, so the ledger lists them, and storage for an object that reports no
size, as not collected. A residual line
("not attributed to a route" or "to a statement") holds whatever the
per-route or per-statement analytics do not account for.

**Missing versus zero.** A five-minute bucket is settled once its end is 45
minutes old, because analytics rows arrive late. The history API reports `0`
for a settled counter bucket that has no row only when a successful collector
run, finished after the bucket settled, covered it. Otherwise the point is
`null`. Gauges (storage, maximum CPU, probes) are never zero-filled, and the
unsettled newest bucket is never filled. Only the last 500 runs are kept, so
buckets older than about two days are not filled.

**History response.** The bucket width is the smallest of 5 minutes, 15
minutes, 1 hour, and 3 hours that gives at most 900 points, and the first
bucket of a range that reaches the retention limit is the first one retention
left whole. Widths under an
hour read `project_samples`; the rest read `project_hours`. A metric response
is a table with one column per metric, every row aligned to `fromMs + i *
stepMs`, in the [history frame](#history-frames); `kind=collector` returns
`runs`. `kinds=...` returns a bundle with one entry per requested kind and reads
one grouped metric window for all requested metric kinds. `GET /projects`
returns each project with `collector.lastRunAtMs`, `lastSuccessAtMs`,
`lastError`, and `stale` (no success in 15 minutes).

**Access.** `ANALYTICS_SQL` can read all of the account's analytics. Only the
fixed queries run, and no request data reaches SQL.

## Dashboard

`cloudflare/src/client/` is a Solid application built by Vite's client
environment and charted with uPlot. `api.ts` decodes every response once at the
boundary; request failures stay in the typed `ApiFailure` channel. A history
response is validated once and wrapped in tables (`columns.ts`, `history.ts`): a
time axis plus named numeric columns whose absent cells are `null`, converted to
chart arrays only for the columns a view reads. `state.ts` owns the range, zoom
stack, and live-refresh state; `chart-data.ts` aligns series onto a shared time
grid, passing through series that already share a gap-free axis. Host and fleet data refresh every 15 seconds;
project data and the project list refresh every five minutes to match the
collector cron, while the manual Refresh button is immediate. Routes are `/`
for hosts, `#/projects`, `#/host/:hostId`, and `#/project/:projectId`. The
browser never sees a host token or an operator secret.

Each summary tile shows its latest value, where that value sits between the
metric's elevated and critical limits, and a zero-based trend in the hue of its
resource group; a tile past a limit gets a status-coloured edge and tint, and
the host's eight tiles share one row. The fleet table carries the status dot,
OS and kernel, CPU model, cores and threads under CPU, disk used of total, and
health-coloured sparklines for CPU, memory, load, and disk space, with disk
read/write and network in/out drawn as mirrored pairs. Pressure panels share
one control for the kernel's 10 s, 1 min, or 5 min PSI average and show the
coverage-weighted mean and peak for the visible range. Chart cards are laid out in aligned
two-column rows so both cards in a row start at the same top edge; the host's
CPU, memory, OS, kernel, agent, and uptime facts live in a hover card beside
its name rather than on the page. A chart's axis fits its data, and an elevated limit is
drawn only once the data reaches half of it. Periods outside a chart's limits
get a tinted vertical band, and hovering one shows its peak, range, and
duration. On project pages the newest buckets, which the collector has not yet
settled (`PROJECT_SETTLE_MS` in `src/limits.ts`), are shaded as still arriving.
The project page keeps its deployments, errors, request explorer, and charts
in sections that start closed; the open sections live in the URL's `open`
parameter, and a deep link such as `deployment=` or `route=` opens its
section. The request explorer loads only while its section is open. Long lists
show their first rows and a "Show more" control, so the page scrolls as one
page. Widgets collapse, and the choice persists in `localStorage`. `make preview` serves the
built client from the captured API fixtures with a frozen clock.

## Non-goals

Per-process profiling, continuous event streaming, eBPF-only observability,
OpenTelemetry, PromQL, Grafana, log search, traces beyond the 7-day
per-invocation records of `docs/observability-campaign.md`, alert routing, arbitrary
queries or unbounded ranges, cgroup or guest semantics beyond the observed
host, and multi-tenant SaaS.
