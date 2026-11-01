# Stats

A small Linux host monitor. One static-musl binary samples CPU, load, memory,
pressure, disks, network, and filesystems every 15 seconds and posts batches
over outbound HTTPS to a Cloudflare Worker. The Worker stores them in a
SQLite-backed Durable Object and serves a dashboard behind Cloudflare Access.
The agent runs on ordinary Debian and Alpine hosts without root, systemd,
containers, or a language runtime.

Niceforge may link a registered runner to a telemetry host; that association
lives in the Niceforge repository, and Niceforge execution never depends on
telemetry.

Deploying the Worker and provisioning hosts: [`docs/operations.md`](docs/operations.md).
Wire protocol: [`docs/protocol.md`](docs/protocol.md). Developer guide: [`AGENTS.md`](AGENTS.md).

## Install the agent

Build the binary with `make agent-build` (see `docs/operations.md`), provision
the host to get a `hostId` and token, then:

```sh
useradd --system --no-create-home --shell /usr/sbin/nologin stats
install -m 0755 stats /usr/local/bin/stats
install -d -m 0700 -o stats -g stats /etc/stats
install -m 0600 -o stats -g stats agent.json /etc/stats/agent.json
install -m 0600 -o stats -g stats token /etc/stats/token
```

Start it with one of:

- systemd: install `agent/contrib/systemd/stats.service` to
  `/etc/systemd/system/`, then `systemctl daemon-reload` and
  `systemctl enable --now stats`.
- OpenRC (Alpine): install `agent/contrib/openrc/stats`, then
  `rc-service stats start`.
- No service manager: `agent/contrib/supervise.sh /etc/stats/agent.json`.

Stop it with SIGTERM; the supervisor and service scripts stop the child and
keep the configuration. Revoke the host credential before removing the binary,
configuration, and token.

## Configuration

The config and the token file must be regular, owner-only files (no group or
other permission bits, no symlinks) owned by the running user. A token is
never accepted in argv or written to logs.

```json
{
  "endpoint": "https://telemetry.example.com",
  "hostId": "h_0123456789abcdef0123456789abcdef",
  "tokenFile": "/etc/stats/token",
  "sampleIntervalMs": 15000,
  "uploadIntervalMs": 30000,
  "maxQueueSamples": 16,
  "requestTimeoutMs": 10000,
  "blockLatencyFile": "/run/stats/block-latency.json"
}
```

Only `endpoint`, `hostId`, and `tokenFile` are required; the interval, queue,
and timeout values shown are the defaults. Unknown keys are rejected, and `agent/src/config.rs` holds the
accepted range of each value. The server allows six ingest requests per host
per minute, so keep `uploadIntervalMs` at 10000 or more.

`blockLatencyFile` is optional. When set, each sample attaches the `block`
group from that file if it is a regular file, not group- or world-writable,
and modified within the last 30 seconds; otherwise `block` is absent. See
[`bpf/README.md`](bpf/README.md) for the collector that writes it.

## Running

```sh
stats --config /etc/stats/agent.json   # run in the foreground
stats --once                           # print one sample as JSON, no network or credential
stats --bench <iterations> <interval_ms>  # sample without network and report cost
stats --version
```

The agent keeps unsent samples in memory only, at most `maxQueueSamples`. A
new sample on a full queue displaces the oldest. Each upload sends up to two
samples, or up to 16 when a backlog has built up. Collection never waits for
an upload.

- 5xx, timeouts, and network errors keep the batch and retry with
  exponential backoff and jitter (1 s base, 60 s cap). 429 honors
  `Retry-After`. A batch put back on a full queue displaces the newest samples.
- Any other 4xx, a TLS failure, or an unclassified transport error drops the
  batch. That includes 401 after a credential is rotated or revoked, so
  restart the agent with the new token right after rotating.
- SIGTERM and SIGINT stop sampling, let any in-flight upload finish, then
  keep uploading until the queue is empty, an upload fails, or 5 seconds have
  passed. Each queued request is bounded by `requestTimeoutMs` (max 30 s); the
  final flush uses a 2 s timeout.

The agent prints accepted, duplicate, rejected, dropped, and failed-upload
counts once, on exit. It logs nothing while it runs.

## Dashboard

Open the Worker's hostname and sign in through Access. The fleet page lists
hosts with status filters (online, stale, no samples, revoked), sortable
columns, and fleet charts. The host page shows CPU, load, available memory,
pressure, disk and network throughput, filesystems, devices, and block latency
(p50, p95, p99), which stays empty unless the collector is configured.

Pick 1 h, 6 h, 24 h, 7 d, or 90 d, or drag across any chart to zoom every
chart to that window (30 s minimum). Keys: `z` zooms out, `[` and `]` pan,
`Escape` resets the zoom, `l` toggles live refresh (every 15 s, paused while
zoomed or when the tab is hidden), `/` focuses the host search.

A host is online when the server received a sample in the last 45 seconds.
Missing values render as `—` or `unavailable`, never as zero.
