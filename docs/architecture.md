# Architecture

A static-musl Rust agent samples each Linux host and posts batches over HTTPS
to a Cloudflare Worker. The Worker forwards ingest and API calls to one
SQLite-backed Durable Object, which stores raw samples and rollups and answers
history queries. A Solid dashboard, served through the same Worker, reads that
API behind Cloudflare Access. The wire contract between agent and Worker is in
[`protocol.md`](protocol.md).

## Agent

`agent/src/main.rs` parses the command line, `config.rs` loads and validates
the config and token, `linux.rs` samples, `runtime.rs` runs the sampling and
upload threads, `queue.rs` holds unsent samples, and `transport.rs` posts with
ureq and rustls against the system trust roots.

Sampling sources and filters:

- CPU from the `/proc/stat` aggregate; no per-core series.
- Memory from `/proc/meminfo` `MemAvailable`; load, uptime, and CPU count from
  `sysinfo(2)`.
- Disks from `/proc/diskstats`, whole devices listed in `/sys/block`,
  excluding `loop*`, `ram*`, `zram*`, and `fd*`.
- Network from `/sys/class/net/<if>/statistics` 64-bit counters, excluding
  `lo`. Sysfs exposes the same `rtnl_link_stats64` counters as rtnetlink
  without hand-built netlink packets or an async netlink crate.
- PSI from `/proc/pressure/{cpu,memory,io}`, kept separate from iowait.
- Filesystems from `/proc/self/mounts` plus `statfs(2)`, limited to the
  allow-list in `agent/src/parse.rs`, at most 16.

Procfs files are reopened each sample into bounded buffers. The baseline agent
has no per-process polling, async runtime, BPF, web server, or dynamic
libraries.

`seq` is `floor(monoMs / 1000)` and the boot id comes from the kernel, so a
process restart within a boot continues the sequence without a state file.
`sampleIntervalMs` has a 1000 ms minimum, which keeps `seq` unique.

## Worker

`cloudflare/src/index.ts` is the whole routing table. `/health` is public.
`/ingest/v1/batches` is forwarded to the Durable Object, which authenticates
the host bearer token. Every other path, including static assets, first passes
`verifyAccess` in `access.ts`. Assets run through the Worker
(`assets.run_worker_first`), so a cache hit cannot bypass authorization.

Routes under `/api/v1/` (handled in `installation.ts`):

- `GET /hosts`, `GET /hosts/:hostId/latest`.
- `GET /hosts/:hostId/history?range=1h|6h|24h|7d|90d&kind=summary|disks|nets|filesystems|block`.
  Pass `from` and `to` (epoch milliseconds, at most 90 days apart) instead of
  `range` for an explicit window; the response then omits `range`.
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

Configuration: `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are Worker secrets;
`ENVIRONMENT`, `INSTALLATION`, and `ASSETS` are bindings declared in
`cloudflare.config.ts`. The Durable Object id is the fixed name `installation`.

## Storage and rollups

One Durable Object per installation holds three tables, created with
`CREATE TABLE IF NOT EXISTS` in `installation.ts`:

- `hosts`: credentials, revocation, last receipt, and the rate-limit window.
- `samples`: raw samples for 48 hours, unique on `(hostId, bootId, seq)`.
- `rollups`: keyed by `(hostId, resolution, bucket)`; one-minute buckets for
  7 days and hourly buckets for 90 days.

Rollups store counter delta sums with the covered interval and gauge sums with
counts; they never average counters. Block histograms sum bucket counts and
totals and keep the observed minimum and maximum; percentiles come from bucket
upper bounds and are not exact. A late sample rebuilds its minute, the minute
of the following sample, and every hour those minutes fall in. A bucket with
less than 80% of its span covered by usable intervals is marked partial.

A Durable Object alarm deletes expired rows in batches of 1000 per tier. It
never repairs or invents data.

History picks raw when the window starts within 48 hours, one-minute rollups
within 7 days, and hourly rollups beyond, so a zoomed window reads finer data
than the preset range it came from. Results are downsampled to at most 900
points and carry a `stepMs`.

One object per installation keeps exactly-once storage and rollups in one
transactional store. Revisit it on measured per-object contention or the
Durable Object storage ceiling.

## Dashboard

`cloudflare/src/client/` is a Solid application built by Vite's client
environment and charted with uPlot. `api.ts` decodes every response once at the
boundary; request failures stay in the typed `ApiFailure` channel. `state.ts`
owns the range, zoom stack, and live-refresh state; `chart-data.ts` aligns
series onto a shared time grid. The browser never sees a host token or an
operator secret.

## Non-goals

Per-process profiling, continuous event streaming, eBPF-only observability,
OpenTelemetry, PromQL, Grafana, logs or traces, alert routing, arbitrary
queries or unbounded ranges, cgroup or guest semantics beyond the observed
host, and multi-tenant SaaS.
