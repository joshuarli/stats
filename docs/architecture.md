# Architecture

A static-musl Rust agent samples each Linux host and posts batches over HTTPS
to a Cloudflare Worker. The Worker forwards ingest and API calls to one
SQLite-backed Durable Object, which stores raw samples and rollups and answers
history queries. A five-minute cron on the same Worker also reads Cloudflare's own analytics for
configured projects, such as a Worker and its R2 buckets. A Solid dashboard,
served through the same Worker, reads that API behind Cloudflare Access. The wire contract between agent and Worker is in
[`protocol.md`](protocol.md).

## Agent

`agent/src/main.rs` parses the command line, `config.rs` loads and validates
the config and token, `linux.rs` samples, `runtime.rs` runs the sampling and
upload threads, `queue.rs` holds unsent samples, and `transport.rs` posts with
ureq and rustls against the system trust roots.

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

`cloudflare/src/index.ts` is the whole routing table. `/health` is public.
`/ingest/v1/batches` is forwarded to the Durable Object, which authenticates
the host bearer token. Every other path that serves assets or data first passes
`verifyAccess` in `access.ts`. Assets run through the Worker
(`assets.run_worker_first`), so a cache hit cannot bypass authorization.
Methods other than GET and HEAD on non-API paths are rejected before routing.
`cloudflare/public/llms.txt` is an ordinary asset, so it passes Access too; it
tells an agent how to authenticate and read the JSON API. A Vite plugin in
`cloudflare/vite.config.ts` copies `docs/protocol.md` and `docs/architecture.md`
into the assets as `/docs/protocol.md` and `/docs/architecture.md`, the two
files `llms.txt` links to; no other doc is served.

Routes under `/api/v1/` (handled in `installation.ts`):

- `GET /hosts`, `GET /hosts/:hostId/latest`, `GET /hosts/:hostId/system`
  (404 until the agent has reported).
- `GET /hosts/:hostId/history?range=1h|6h|24h|7d|90d&kind=summary|disks|nets|filesystems|block`.
  Pass `from` and `to` (epoch milliseconds, at most 90 days apart) instead of
  `range` for an explicit window; the response then omits `range`. Pass
  `kinds=summary,disks,nets` instead of `kind` to receive several kinds at once
  under `histories`.
- `GET /projects` and `GET /projects/:id/history?range=1h|6h|24h|7d|90d&kind=worker|routes|durable-objects|r2|d1|d1-statements|probes|collector`
  (see [Cloudflare projects](#cloudflare-projects)).
- `POST /admin/hosts`, `GET /admin/hosts`, `POST /admin/hosts/:hostId/rotate`,
  `DELETE /admin/hosts/:hostId` (revoke), `DELETE /admin/hosts/:hostId/purge`.

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

## Storage and rollups

One Durable Object per installation holds the host tables below and the project
tables in [Cloudflare projects](#cloudflare-projects), created with
`CREATE TABLE IF NOT EXISTS` in `installation.ts`:

- `hosts`: credentials, revocation, last receipt, and the rate-limit window.
- `host_system`: the latest `system` object per host and when it arrived.
- `samples`: raw samples for 48 hours, unique on `(hostId, bootId, seq)`.
- `rollups`: keyed by `(hostId, resolution, bucket)`; one-minute buckets for
  7 days and hourly buckets for 90 days.

Rollups store counter delta sums with the interval each device covered and
gauge sums with counts; they never average counters. A device rate divides by
its own covered interval, so a missing sample is a gap rather than a lower
rate; swap in and out sums carry their own covered interval the same way. Block histograms sum bucket counts and totals and keep the observed
minimum and maximum; percentiles come from bucket upper bounds and are not
exact. A late sample rebuilds its minute, the minute
of the following sample, and every hour those minutes fall in. A bucket with
less than 80% of its span covered by usable intervals is marked partial.

A Durable Object alarm deletes expired rows in batches of 1000 per tier. It
never repairs or invents data.

History picks raw when the window starts within 48 hours, one-minute rollups
within 7 days, and hourly rollups beyond, so a zoomed window reads finer data
than the preset range it came from. Results are downsampled to at most 900
points and carry a `stepMs`, with fractions rounded to three decimals.

A preset range ends at the current 15-second raw step, and the Durable Object
keeps the last four windows it built, each for every history kind. The
dashboard asks for all five kinds in one batched history request on each
refresh, and for a second window for the yesterday comparison every five
minutes, so one read and parse of a window serves all of its kinds. Ingest, a
purge, and an alarm that deleted rows discard them; an alarm that deleted
nothing keeps them. Summary points carry `cpuCount` and `uptimeMs`; the
dashboard reads a fall in uptime as a reboot.

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

**Storage** (schema version 6; version 5 dropped Worker, route, R2 operation, and D1
history before 2026-11-01 20:40 UTC, which was weighted by a mismatched
`sampleInterval`, and version 6 dropped the collector runs before 22:10 UTC the
same day so those buckets read as unknown instead of zero):

- `project_samples(project, metric, bucket_ms, value)`: five-minute buckets for
  7 days.
- `project_hours(project, metric, hour_ms, value)`: hourly buckets for 90 days,
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
project, and it has no storage-size source. Worker CPU is
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

The project page's Estimated cost widget multiplies collected usage (Worker
requests and CPU, Durable Object requests, D1 rows) by the Workers Paid list
prices in `cloudflare/src/client/pricing.ts`. Worker requests count the
entrypoint only, so an ingest is one Worker request and one Durable Object
request, not two Worker requests. It is a list-price figure for the
range shown, before the included monthly allowances, and leaves out R2, storage,
and Durable Object duration, so it ranks where spend comes from and is not a
bill.

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
is `{projectId, range, kind, fromMs, toMs, stepMs, series: [{metric, values}]}`
with every series aligned to `fromMs + i * stepMs`; `kind=collector` returns
`runs`. `GET /projects` returns each project with `collector.lastRunAtMs`,
`lastSuccessAtMs`, `lastError`, and `stale` (no success in 15 minutes).

**Access.** `ANALYTICS_SQL` can read all of the account's analytics. Only the
fixed queries run, and no request data reaches SQL.

## Dashboard

`cloudflare/src/client/` is a Solid application built by Vite's client
environment and charted with uPlot. `api.ts` decodes every response once at the
boundary; request failures stay in the typed `ApiFailure` channel. `state.ts`
owns the range, zoom stack, and live-refresh state; `chart-data.ts` aligns
series onto a shared time grid. Routes are the fleet page, `#/host/:hostId`,
and `#/project/:projectId`; the fleet page lists projects under the hosts. The browser never sees a host token or an
operator secret.

Each summary tile shows its latest value, where that value sits between the
metric's elevated and critical limits, and a zero-based trend in the hue of its
resource group; a tile past a limit gets a status-coloured edge and tint, and
the host's eight tiles share one row. The fleet table carries the status dot,
OS, CPU model and core count, and a sparkline for CPU, memory, disk, and
network. Chart cards are laid out in aligned
two-column rows so both cards in a row start at the same top edge; the host's
CPU, memory, OS, kernel, agent, and uptime facts live in a hover card beside
its name rather than on the page. A chart's axis fits its data, and an elevated limit is
drawn only once the data reaches half of it. Periods outside a chart's limits
get a tinted vertical band, and hovering one shows its peak, range, and
duration. On project pages the newest buckets, which the collector has not yet
settled (`PROJECT_SETTLE_MS` in `src/limits.ts`), are shaded as still arriving,
and a count tile such as Requests reports the last settled bucket; ratio tiles
use the newest bucket because both sides of the ratio are partial. Widgets
collapse, and the choice persists in `localStorage`. `make preview` serves the
built client from the captured API fixtures with a frozen clock.

## Non-goals

Per-process profiling, continuous event streaming, eBPF-only observability,
OpenTelemetry, PromQL, Grafana, logs or traces, alert routing, arbitrary
queries or unbounded ranges, cgroup or guest semantics beyond the observed
host, and multi-tenant SaaS.
