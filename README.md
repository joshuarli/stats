# Niceforge host telemetry

A small static-musl Linux host monitor, an outbound HTTPS batcher, a Cloudflare
Worker with one SQLite-backed Durable Object, and a bounded HTML/SVG dashboard.
The agent runs on ordinary Debian and Alpine hosts without Niceforge, systemd,
root, containers, or a language runtime. Niceforge may link a registered runner
to a telemetry host; execution never depends on telemetry.

Layout:

| Path | Purpose |
| --- | --- |
| `telemetry/agent/` | Rust collector and transport |
| `telemetry/fixtures/v1/` | Canonical wire fixtures and accept/reject oracle |
| `telemetry/cloudflare/` | Worker, Durable Object, dashboard, tests |
| `telemetry/bench/` | Benchmark harness and recorded method |
| `telemetry/tools/` | Zig cross-linker wrappers for static musl builds |

The campaign record is [`docs/CAMPAIGN-HOST-TELEMETRY.md`](../docs/CAMPAIGN-HOST-TELEMETRY.md).

## Wire protocol v1

Transport is HTTPS with system trust roots. The host sends `POST /ingest/v1/batches`
with `Authorization: Bearer nft_<43 base64url chars>`, `Content-Type: application/json`,
and a body of at most 65,536 bytes. A batch contains 1–16 samples.

```json
{
  "v": 1,
  "hostId": "h_0123456789abcdef0123456789abcdef",
  "bootId": "3f2a9c1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f",
  "samples": []
}
```

`hostId` must match the credential's host. `bootId` is the kernel boot UUID from
`/proc/sys/kernel/random/boot_id`. Counters are decimal u64 strings; timing and
sequence fields are decimal strings at most 2^53-1 so neither edge can round
them silently. JSON numbers are used only for `v` and `cpuCount`.

### Sample

| Field | Required | Shape |
| --- | --- | --- |
| `seq` | yes | decimal string, at most 2^53-1; `floor(monoMs / 1000)` |
| `atMs` | yes | epoch milliseconds, at most 2^53-1 |
| `monoMs` | yes | monotonic milliseconds since boot, at most 2^53-1 |
| `unavailable` | no | array of `cpu`, `load`, `mem`, `uptime`, `disks`, `nets`, `psi`, `filesystems`; at most 8, unique |
| `cpu` | no | `user`, `system`, `idle`, `iowait`, `steal`, `total`, each a u64 string |
| `load` | no | `one`, `five`, `fifteen`, each a fixed 3-decimal string |
| `mem` | no | `total`, `available`, `swapTotal`, `swapFree`, each a byte string |
| `uptimeMs` | no | u64 string |
| `cpuCount` | no | integer 1–4096 |
| `disks` | no | 0–16 objects: `id` (`major:minor`), `name` (1–32 chars), `reads`, `readSectors`, `writes`, `writeSectors`, `ioMs` |
| `nets` | no | 0–16 objects: `id` (interface name), `rxBytes`, `rxPackets`, `rxDrops`, `rxErrors`, `txBytes`, `txPackets`, `txDrops`, `txErrors` |
| `psi` | no | optional `cpu`, `memory`, `io`; each has `some10`, `some60`, `some300` (fixed 2-decimal percent) and `total` (microseconds); `memory` and `io` may also have `full10`, `full60`, `full300`, `fullTotal` |
| `filesystems` | no | 0–16 objects: `id` (mount path), `type` (allow-list enum), `total`, `available` |

A listed `unavailable` group must not also be present. A sample with no metric
group is invalid. Unknown fields at any level are invalid. Device ids and
interface names must be unique within their array.

CPU constants: `user` is user+nice, `system` is system+irq+softirq; `total` is
their sum with `idle`, `iowait`, and `steal`. Disk sectors are always 512-byte
kernel sectors. Filesystem `available` uses `f_bavail` (available to an
unprivileged process). `psi` averages are percentages; `total` is microseconds.

### Validation and response

The server checks, in order: body size (`too_large`), JSON (`invalid_json`),
version (`unknown_version`), batch shape (`invalid_batch`), credential
(`unauthorized`), host binding (`forbidden`), rate limit (`rate_limited`), then
each sample (`invalid_sample` with a `seq` when parseable). Observed timestamps
more than 5 minutes in the future are `invalid_sample`; older than 48 hours are
`too_old`.

A duplicate `(hostId, bootId, seq)` with identical canonical bytes is counted
as a duplicate and is not an error. The same key with different bytes is a
`conflict`. A batch with at least one accepted or duplicate sample returns 200:

```json
{ "v": 1, "accepted": 1, "duplicates": 1, "rejected": [{ "seq": "1000002", "code": "invalid_sample" }] }
```

If nothing was accepted or duplicated, the response is 400 with
`{ "error": { "code": "...", "message": "..." } }`. Rejections never include
credentials, token hashes, or request bodies. Other statuses: 401 missing or
revoked credential, 403 host mismatch, 413 too large, 429 rate limited, 503
temporarily unavailable.

### Identity, clock, and rates

- `bootId` changes on reboot. `monoMs` is the interval clock; wall-clock jumps
  do not create or destroy rates.
- Online means a sample was received by the server within 45 seconds. Display
  time uses `atMs`; freshness uses server receipt time. Neither is trusted for
  authorization.
- Rates use consecutive samples of the same boot with strictly increasing
  `monoMs` and `seq`, and non-decreasing counters. Counter regression is a gap,
  never a negative rate. No offline period is interpolated.
- CPU percentages are counter deltas divided by the delta of `total`.
- Disk and network rates are deltas divided by the monotonic interval. Disk
  bytes use 512-byte sectors. `ioMs / interval` is busy time and may exceed
  100% when the device has concurrent I/O.
- A device or interface id that disappears and returns starts a new series.
  Its name is display text, not identity.

### Storage and rollups

One Durable Object per installation stores:

- raw samples for 48 hours, unique on `(hostId, bootId, seq)`;
- one-minute aggregates for 7 days;
- hourly aggregates for 90 days.

Aggregates store counter delta sums plus covered interval, and gauge min/avg/max.
They never average counters. A late sample recomputes its minute bucket, the
following minute, and both affected hours. A bucket with less than 80% of its
span covered by usable intervals is marked partial. Retention runs on a Durable
Object alarm in bounded batches; it never repairs or invents data.

Queries choose raw for ranges up to 48 hours, one-minute rollups up to 7 days,
and hourly beyond. Results are downsampled to at most 900 points with an explicit
step, and gaps remain gaps.

## Agent

Configuration is JSON, owner-only, with a separate owner-only credential file.
A token is never accepted in argv or written to logs.

```json
{
  "endpoint": "https://telemetry.example.com",
  "hostId": "h_0123456789abcdef0123456789abcdef",
  "tokenFile": "/etc/niceforge-telemetry/token",
  "sampleIntervalMs": 15000,
  "uploadIntervalMs": 30000,
  "maxQueueSamples": 16,
  "requestTimeoutMs": 10000
}
```

`niceforge-telemetry --config /etc/niceforge-telemetry/agent.json` runs in the
foreground. `--once` prints one sample as JSON and exits without reading a
credential or contacting the network. `--version` prints the version.

The agent samples every 15 seconds, uploads up to two samples every 30 seconds,
and keeps at most 16 unsent samples in memory. Collection never blocks on an
upload. Saturation drops the oldest sample and increments a loss counter.
Connect, read, and write have finite deadlines. Retries use exponential backoff
with jitter (1 second base, 60 second cap); 429 honors `Retry-After`; other 4xx
drop the batch as non-retryable; 5xx and transport failures retain it. SIGTERM
and SIGINT stop sampling and attempt one bounded final upload. There is no disk
spool by default.

Credentials are 32 random bytes encoded as `nft_` plus base64url. Rotate or
revoke them in the operator API. The server stores only a SHA-256 verifier.

`contrib/supervise.sh` is an init-independent loop for hosts without a service
manager. `contrib/openrc/niceforge-telemetry` is optional on Alpine. No systemd
unit is required on Debian; use the supervisor or the host's init.

## Cloudflare Worker

Local tests run entirely in the Workers runtime. Production routes:

- `POST /ingest/v1/batches` — host bearer token.
- `GET /health` — public, no host data.
- `GET /api/v1/hosts` — Access-protected host list.
- `GET /api/v1/hosts/:hostId/latest` — Access-protected latest sample.
- `GET /api/v1/hosts/:hostId/history?range=1h|6h|24h|7d|90d&kind=summary|disks|nets|filesystems`
  — Access-protected bounded history.
- `POST /api/v1/admin/hosts`, `GET /api/v1/admin/hosts`,
  `POST /api/v1/admin/hosts/:hostId/rotate`,
  `DELETE /api/v1/admin/hosts/:hostId` — Access-protected provisioning.

Human requests carry `Cf-Access-Jwt-Assertion`, verified in the Worker against
the team JWKS with issuer, audience, expiry, and not-before checks. Edge Access
alone is not accepted. Test configuration supplies `ACCESS_JWKS_JSON`; it is
ignored unless `ENVIRONMENT=test`.

Static assets run through the Worker (`assets.run_worker_first = true`), so a
cache hit cannot bypass authorization. `workers_dev` and preview URLs are
disabled; the deployment must not expose an alternate hostname. Response
headers set a self-only CSP, `frame-ancestors 'none'`, `nosniff`, and a strict
referrer policy.

Configuration values: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`,
`INSTALLATION` (Durable Object binding), `ENVIRONMENT`, and the optional test
`ACCESS_JWKS_JSON`. The Durable Object id is the fixed name `installation`.

## Dashboard

The dashboard is one HTML entrypoint and one ES module bundle built by esbuild.
It has a fleet table and a per-host view with 1 h, 6 h, 24 h, 7 d, and 90 d
ranges. Charts are native SVG with keyboard focus and text readouts. Missing
data renders as `unavailable` or a gap; it is never zero. Access handles login;
the browser never sees a host token or an operator secret.

Build: `pnpm --filter @niceforge/telemetry build`. Browser tests:
`pnpm --filter @niceforge/telemetry test:ui` with request interception from
deterministic fixtures. No fixture endpoint or auth bypass exists in the built
assets. Recorded 2026-10-31: 13,187 bytes JavaScript (4,677 gzip), 4,103 bytes
CSS (1,416 gzip), 553 bytes HTML (371 gzip); Chromium local load about 58 ms on
the development host. These are local measurements, not production claims.

## Local checks

```sh
make telemetry-fixtures          # manifest, fixture shapes, cost arithmetic
make telemetry-agent-test        # collector and transport unit tests
make telemetry-agent-build       # static x86_64 and aarch64 binaries + ELF checks
make telemetry-cloudflare-test   # Workers runtime integration
make telemetry-dashboard-test    # bundle + Playwright
make telemetry-association-test  # Niceforge schema migration and workbench
make telemetry-release           # release binaries, receipts, benchmark self-test
make telemetry-check             # all local telemetry checks
```

Runtime proofs on real Debian/Alpine hosts, Cloudflare billing and Access, and
BPF support are recorded as Needs environment in the campaign record.

## Release and benchmark

`telemetry/agent/scripts/build-static.sh` builds both musl targets with the
committed Zig wrappers, strips them, writes versioned
`niceforge-telemetry-<version>-<target>` artifacts and SHA-256 receipts under
`telemetry/agent/dist/`, and rejects an ELF with `PT_INTERP` or `NEEDED`.
Recorded 2026-10-31: 1,943,832 bytes x86_64 and 1,733,792 bytes aarch64
stripped binaries; repeated builds produced identical SHA-256 digests, and the
ELF receipts show no interpreter and no dynamic dependencies.
`telemetry/bench/bench.sh` records a named host, kernel, CPU, interval, and
method, then reports CPU time per sample, steady RSS, cycles, instructions,
syscalls, context switches, collection latency, and bytes sent. It compares
with Node Exporter only on the same host and interval. Performance is
unverified until those numbers exist; the campaign's targets are aspirations,
not claims.

## Install, start, stop, and remove

Installation is a single binary and owner-only files:

```sh
install -m 0755 niceforge-telemetry /usr/local/bin/niceforge-telemetry
install -d -m 0700 /etc/niceforge-telemetry
install -m 0600 agent.json /etc/niceforge-telemetry/agent.json
install -m 0600 token /etc/niceforge-telemetry/token
telemetry/agent/contrib/supervise.sh /etc/niceforge-telemetry/agent.json
```

On Alpine, install `contrib/openrc/niceforge-telemetry` and run
`rc-service niceforge-telemetry start`. Stop with SIGTERM; the supervisor and
OpenRC script stop the child and do not delete configuration. Remove the
binary, configuration, and token only after revoking the host credential.
Cloudflare teardown is separate and owner-run.

## Deployment outline

The owner runs these steps; the implementation never does.

1. Create an Access application for the dashboard and custom domain; record the
   team domain and audience.
2. Set `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and `ENVIRONMENT=production` as
   Worker secrets/vars. Keep `workers_dev` and preview URLs disabled.
3. Apply the Durable Object migration and deploy with pinned Wrangler.
4. Provision one host with the admin API; record the token once in an
   owner-only file; install the agent and supervisor.
5. Verify live samples, restart persistence, revocation, stale state, rollups,
   and the dashboard; set spend alarms.
6. Tear down only the resources this deployment created.

## Needs environment

- Real Debian and Alpine hosts, x86_64 and aarch64, for kernel interfaces,
  trust stores, init scripts, and runtime proofs.
- Named Linux hardware with `/usr/bin/time` and `perf` for benchmark results.
- A Cloudflare account, Access application, custom domain, and paid-plan
  limits for production proof and billing.
- A live Niceforge runner host for the opt-in deep-link proof.
- A capable Linux kernel with BTF and privileges for optional eBPF.
