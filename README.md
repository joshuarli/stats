# Niceforge host telemetry

A small static-musl Linux host monitor, an outbound HTTPS batcher, a Cloudflare
Worker with one SQLite-backed Durable Object, and a bounded HTML/SVG dashboard.
The agent runs on ordinary Debian and Alpine hosts without Niceforge, systemd,
root, containers, or a language runtime. Niceforge may link a registered runner
to a telemetry host; execution never depends on telemetry.

This project is maintained in its own repository, extracted from Niceforge on
2026-10-31. The runner association remains a Niceforge contract and workbench
feature.

Layout:

| Path | Purpose |
| --- | --- |
| `agent/` | Rust collector and transport |
| `fixtures/v1/` | Canonical wire fixtures and accept/reject oracle |
| `cloudflare/` | Worker, Durable Object, dashboard, tests |
| `bench/` | Benchmark harness and recorded method |
| `bpf/` | Optional block-latency probe and collector |
| `deploy/` | Worker deploy, host inventory, and live smoke checks |
| `tools/` | Zig cross-linker wrappers for static musl builds |

The campaign record is [`docs/CAMPAIGN-HOST-TELEMETRY.md`](docs/CAMPAIGN-HOST-TELEMETRY.md).

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
| `block` | no | `buckets` (exactly 16 u64 strings), `count`, `totalUs`, `minUs`, `maxUs` |

A listed `unavailable` group must not also be present. A sample with no metric
group is invalid. Unknown fields at any level are invalid. Device ids and
interface names must be unique within their array.

`block` is an optional interval histogram of block-layer request latency in
microseconds. Bucket upper bounds are `100`, `250`, `500`, `1000`, `2500`,
`5000`, `10000`, `25000`, `50000`, `100000`, `250000`, `500000`, `1000000`,
`2500000`, `5000000`, and overflow. `count` is the sum of the 16 buckets;
`totalUs`, `minUs`, and `maxUs` are the sum, minimum, and maximum observed
latency. A zero count requires all four totals to be zero. The group is absent
when the optional probe is not configured; it is never synthesized.

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
They never average counters. Block histograms sum bucket counts and totals and
keep the observed minimum and maximum; percentiles are derived from bucket
upper bounds and are not exact. A late sample recomputes its minute bucket, the
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
  "requestTimeoutMs": 10000,
  "blockLatencyFile": "/run/niceforge-telemetry/block-latency.json"
}
```

`blockLatencyFile` is optional. When set, the agent attaches the latest
`block` group from that file if it is a regular file, is not group/world
writable, and was modified within the last 30 seconds. The file is written
atomically by `bpf/collector.sh`; a missing or stale file simply
leaves `block` absent. The baseline agent never loads BPF and works without
this field.

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
manager. `contrib/openrc/niceforge-telemetry` is available on Alpine, and
`contrib/systemd/niceforge-telemetry.service` is available on systemd hosts.
No service manager is required; the supervisor or the host's init works.

## Cloudflare Worker

Local tests run entirely in the Workers runtime. Production routes:

- `POST /ingest/v1/batches` — host bearer token.
- `GET /health` — public, no host data.
- `GET /api/v1/hosts` — Access-protected host list.
- `GET /api/v1/hosts/:hostId/latest` — Access-protected latest sample.
- `GET /api/v1/hosts/:hostId/history?range=1h|6h|24h|7d|90d&kind=summary|disks|nets|filesystems|block`
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

The dashboard is a client-rendered Solid application built by Vite's client
environment. The fleet table and per-host view share a 1 h, 6 h, 24 h, 7 d, and
90 d range control. The host view includes CPU, load, available memory, pressure,
disk, network, filesystem, and block-latency widgets; the block chart appears
only when the optional probe reports completions. Charts are native SVG with
keyboard focus, pointer/keyboard readouts, and explicit gaps. Missing data
renders as `—`, `unavailable`, or a gap; it is never zero. API responses are
decoded once at the boundary, and request failures stay in a typed `ApiFailure`
channel. Access handles login; the browser never sees a host token or an
operator secret.

Build: `pnpm --filter @niceforge/telemetry build`. Browser tests:
`pnpm --filter @niceforge/telemetry test:ui` with request interception from
deterministic fixtures. No fixture endpoint or auth bypass exists in the built
assets.

## Local checks

```sh
make fixtures          # manifest, fixture shapes, cost arithmetic
make agent-test        # collector and transport unit tests
make agent-build       # static x86_64 and aarch64 binaries + ELF checks
make cloudflare-test   # typecheck + Workers runtime integration
make dashboard-test    # bundle + Playwright
make lint              # TypeScript-aware Oxlint
make release           # release binaries, receipts, benchmark self-test
make check             # all local telemetry checks
```

Runtime proofs on Ubuntu and Alpine x86_64, a container-scoped aarch64 runtime
on Debian 13 and Alpine edge, Cloudflare Access, the optional BPF probe, and the
A9 benchmark are recorded in the campaign, benchmark, and BPF records. A
bare-host aarch64 kernel/init/reboot proof and Workers Paid limits remain Needs
environment.

### Container-scoped aarch64 runtime

Recorded 2026-10-31 on an Apple Silicon host with Docker 29.8.2 and OrbStack
(native `linux/arm64`, kernel `7.2.12-orbstack`). The static aarch64 binary ran
in `debian:13-slim` and `alpine:edge`: `--version`, `--once`, `--bench`, and a
direct agent run against a local HTTPS ingest signed by a proof CA. Both
containers also validated `https://stats.17166969.xyz/health` with their system
trust store. Debian ran `contrib/supervise.sh`; Alpine ran the OpenRC service.
Samples included CPU, load, memory, uptime, disks, networks, and filesystems;
PSI was `unavailable` because the OrbStack kernel has no `/proc/pressure`.

This is a container-scoped proof, not a bare-host proof. It does not cover
Debian or Alpine kernel behavior, systemd boot, reboot persistence, or
host-level block/eBPF telemetry. OpenRC was started with `rc-service -D` because
container networking cannot satisfy its `need net` dependency. Live Cloudflare
ingest was not repeated; the agent used a local HTTPS ingest, and the Worker
path was live-proven in T9.

## Release and benchmark

`agent/scripts/build-static.sh` builds both musl targets with the committed Zig
wrappers, strips them, writes versioned
`niceforge-telemetry-<version>-<target>` artifacts and SHA-256 receipts under
`agent/dist/`, and rejects an ELF with `PT_INTERP` or `NEEDED`.
Recorded 2026-10-31: 1,943,832 bytes x86_64 and 1,733,792 bytes aarch64
stripped binaries; repeated builds produced identical SHA-256 digests, and the
ELF receipts show no interpreter and no dynamic dependencies.
`bench/bench.sh` records a named host, kernel, CPU, interval, and
method, then reports CPU time per sample, steady RSS, cycles, instructions,
syscalls, context switches, collection latency, and bytes sent. It compares
with Node Exporter only on the same host and interval. Performance is
unverified until those numbers exist; the campaign's targets are aspirations,
not claims.

## Optional block latency

`bpf/` provides a bpftrace collector and a human-readable probe for
block-layer request latency. The collector writes a 15-second snapshot; when
`blockLatencyFile` is configured, the agent attaches the optional `block` group
and the Worker stores, rolls up, and serves it for the dashboard. The baseline
agent never loads BPF and runs without the collector. See
`bpf/README.md` for requirements and usage.

## Install, start, stop, and remove

Installation is a single binary, owner-only files, and an optional service:

```sh
useradd --system --no-create-home --shell /usr/sbin/nologin niceforge-telemetry
install -m 0755 niceforge-telemetry /usr/local/bin/niceforge-telemetry
install -d -m 0700 -o niceforge-telemetry -g niceforge-telemetry /etc/niceforge-telemetry
install -m 0600 -o niceforge-telemetry -g niceforge-telemetry agent.json /etc/niceforge-telemetry/agent.json
install -m 0600 -o niceforge-telemetry -g niceforge-telemetry token /etc/niceforge-telemetry/token
```

On systemd hosts, install `contrib/systemd/niceforge-telemetry.service` to
`/etc/systemd/system/`, then `systemctl daemon-reload` and `systemctl enable
--now niceforge-telemetry`. Without a service manager, run
`contrib/supervise.sh /etc/niceforge-telemetry/agent.json`. On Alpine, install
`contrib/openrc/niceforge-telemetry` and run `rc-service niceforge-telemetry
start`. Stop with SIGTERM; the supervisor and service scripts stop the child and
do not delete configuration. Remove the binary, configuration, and token only
after revoking the host credential. Cloudflare teardown is separate and
owner-run.

## Deployment

`deploy/hosts.json` is the host inventory. It currently tracks:

| Key | SSH | Init | Elevation |
| --- | --- | --- | --- |
| `oracle` | `ubuntu@oracle` | systemd | passwordless `sudo` |
| `threadripper` | `josh@threadripper` | OpenRC | passwordless `doas` |

The manifest also records the dashboard label and static-musl target. Host
deploys install the binary and service unit from `agent/contrib/`; they compare
the SHA-256 and unit content, restart only on a change, preserve
`/etc/niceforge-telemetry/agent.json` and the token, and fail when the config is
missing.

Routine rollout:

```sh
make worker-check          # cf build validation, no upload
make deploy                # tests, Worker, live smoke, then both hosts
make deploy-oracle         # one host, idempotent
make deploy-threadripper   # one host, idempotent
make deploy-hosts          # every host in the manifest
make smoke-deployed        # read-only live check
```

`make deploy` runs `make worker-test`, builds one bundle with `cf build`, deploys
it with `cf deploy --prebuilt`, smoke-checks the live site, then updates the
hosts. `NICEFORGE_TELEMETRY_DOMAIN` defaults to `stats.17166969.xyz`; override it
for another hostname. Pass `SECRETS_FILE=...` to upload Worker secrets; omitting
it leaves existing secrets in place. The `cf` session must be authenticated.

### First deployment

Recorded 2026-10-31 as the T9 proof at `https://stats.17166969.xyz`.

1. Create an Access application for the dashboard hostname with an owner allow
   policy; record the team domain and audience. Access fronts the whole
   hostname, so also create path-scoped Bypass applications for the public
   health check and host ingest:
   - `stats.17166969.xyz/health` with Bypass/Everyone.
   - `stats.17166969.xyz/ingest/*` with Bypass/Everyone. The Worker still
     requires a host bearer token on ingest.

   Without these path applications, Access challenges `/health` and ingest
   before the Worker sees them.
2. Deploy the Worker with `make worker-deploy`. `cloudflare.config.ts` declares
   the Worker, the SQLite Durable Object export, the `ASSETS` binding, the custom
   domain, and the disabled `workers_dev` and preview URLs. `cf build` validates
   the same output without uploading. `wrangler.test.jsonc` is test-only
   configuration for `@cloudflare/vitest-plugin`; it is not a deploy
   configuration.
3. Set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` as Worker secrets, for example with
   `make worker-deploy SECRETS_FILE=...`. `ENVIRONMENT` is the production text
   binding in `cloudflare.config.ts`.
4. Authenticate a human through Access (`cf access login
   https://stats.17166969.xyz`), then provision each host with `POST
   /api/v1/admin/hosts`. Record each token once in an owner-only file, install
   the agent config and token, then run `make deploy-hosts`.
5. Verify live ingest, replay dedupe, latest/history, the dashboard, rotation,
   and revocation with `make smoke-deployed` plus host checks, then revoke any
   disposable host. Set spend alarms before fleet use.
6. Tear down only the resources this deployment created.

Recorded 2026-10-31: live ingest accepted two samples, an exact replay returned
two duplicates, latest and 1 h history returned, the dashboard returned 200
with the CSP and frame protections, a rotated credential rejected the old token
and accepted the new one, and revocation returned 204 with later ingest
returning 401. The host half ran on Ubuntu 24.04.4 LTS and Alpine edge, both
x86_64, under systemd and OpenRC; both uploaded live samples, sequence
continued across restarts, a stopped host became offline after 45 s, and
Alpine reported PSI as unavailable. The account stayed on its free plan;
Workers Paid limits, spend alarms, overage behavior, and the bare-host aarch64
kernel/init/reboot proof remain unverified. The container-scoped aarch64
runtime passed 2026-10-31.

## Needs environment

- aarch64 bare-host kernel/init/reboot proof. Container-scoped Debian 13 and
  Alpine edge aarch64 runtime passed 2026-10-31; the container proof does not
  cover Debian/Alpine kernel behavior, systemd boot, reboot persistence, or
  host-level block/eBPF telemetry.
- Workers Paid limits, spend alarms, and overage behavior. The recorded T9
  cloud half uses the free plan; fleet-scale billing is unverified.
- A live Niceforge runner host for the opt-in deep-link proof.
