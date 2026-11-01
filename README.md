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
and timeout values shown are the defaults. Unknown keys are rejected, and
`agent/src/config.rs` holds the accepted range of each value.
`sampleIntervalMs` must be at least 15000 because raw history uses a
15-second step, and `uploadIntervalMs` must be at least 10000 to stay under
the server's six ingest requests per host per minute.

`includeVirtualInterfaces` and `includeVirtualFilesystems` are optional and
default to `false`. By default the agent reports only physical network
interfaces (those with a sysfs `device` link, so no `veth*`, bridges, or
tunnels) and skips `tmpfs` and `overlay` mounts, which container hosts have
dozens of. Set either to `true` to report them again; each list is still
capped at 16.

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

- 5xx, timeouts, TLS failures, network errors, and statuses other than the
  permanent ones below keep the batch and retry with exponential backoff and
  jitter (1 s base, 60 s cap). 429 honors `Retry-After`. A batch put back on a
  full queue displaces the newest samples.
- 400, 404, 413, 422, or a bad URL drops the batch. A queued batch is trimmed
  to the 65,536-byte encoded body cap before it is sent; a single sample
  larger than the cap is dropped.
- 401 and 403 keep the batch, retry at the 60 s cap, and reread the token file
  before each retry. Rotating a host token is a file replace; the agent picks
  up the new token without a restart. A revoked host keeps retrying and
  logging until the token file changes or the agent stops.
- SIGTERM and SIGINT stop sampling, let any in-flight upload finish, then
  keep uploading until the queue is empty, an upload fails, or 5 seconds have
  passed. Each queued request is bounded by `requestTimeoutMs` (max 30 s); the
  final flush uses a 2 s timeout.

The agent logs each failed upload to stderr with the error class and message,
without the token or body. A repeated failure logs once immediately and then
only a count every 60 seconds. On exit it prints `accepted`, `duplicates`,
`rejected_by_server`, `dropped_local`, and `upload_failures` counts.

## Dashboard

Open the Worker's hostname and sign in through Access. The fleet page lists
hosts with status filters (online, stale, no samples, revoked), sortable
columns, and fleet charts. The host page opens with the host's CPU model and topology, memory, OS, kernel, and
agent version, which the agent reports with its first upload after an update and
then hourly. Below that it shows CPU (including steal), load, available memory, swap used, swap activity,
memory pressure (10 s, 60 s, 300 s), PSI some and full stalls, disk throughput,
operations, and busy time, network throughput, packets, drops, and errors,
filesystem usage over time, filesystems, devices, and block latency with
completions (p50, p95, p99, min, max), which stays empty unless the collector
is configured. Full stalls appear only when the kernel reports them.

Pick 1 h, 6 h, 24 h, 7 d, or 90 d, or drag across any chart to zoom every
chart to that window. The smallest zoom is two samples of the tier the window
reads: 30 s raw, 2 min for one-minute rollups, and 2 h for hourly rollups.
Keys: `z` zooms out, `[` and `]` pan,
`Escape` resets the zoom, `l` toggles live refresh (every 15 s, paused while
zoomed or when the tab is hidden), `/` focuses the host search.

A host is online when the server received a sample in the last 45 seconds.
Missing values render as `—` or `unavailable`, never as zero.

Charts mark where a metric is elevated or critical: a tinted zone and dashed
limit line, a line that changes color where it crosses a limit, a marker where
it went bad and where it recovered, and a caption such as "Critical since
07:11 · 23 min" or "OK · recovering since 07:29". Status always carries an
icon and a word, never color alone. Series colors mean the same thing on every
chart (in/read blue, out/write aqua, CPU blue, memory aqua, I/O violet), and
the status colors are reserved for state. The limits are in
`cloudflare/src/client/health.ts`. A metric is recovered after five minutes
back inside its limits. The device tables list only devices still reporting.
