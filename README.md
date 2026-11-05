# Stats

A small Linux and macOS host monitor. One binary (static musl on Linux)
samples CPU, load, memory, pressure, disks, network, and filesystems every 15
seconds and posts batches
over outbound HTTPS to a Cloudflare Worker. The Worker stores them in a
SQLite-backed Durable Object and serves a dashboard behind Cloudflare Access.
The agent runs on ordinary Debian and Alpine hosts without root, systemd,
containers, or a language runtime.

Niceforge may link a registered runner to a telemetry host; that association
lives in the Niceforge repository, and Niceforge execution never depends on
telemetry.

Deploying the Worker and provisioning hosts: [`docs/operations.md`](docs/operations.md).
Wire protocol (binary ingest v2): [`docs/protocol.md`](docs/protocol.md). Developer guide: [`AGENTS.md`](AGENTS.md).

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

## Install on macOS or Alpine

With this repository and `cf access login https://stats.17166969.xyz` done,
point it at the host:

```sh
make add-host NAME=m1-max SSH=josh@m1-max
```

The target detects the remote OS. On macOS it builds the native binary and
installs a launchd user agent under the login account, with no root. On Alpine
it builds the static musl binary and installs an OpenRC service that runs as
the `stats` user, using passwordless `doas` or `sudo`. Either way it creates
the host when the name is new, rotates the token when the server knows the host
but the target has no config, installs the binary, config, token, and service
unit, and waits for the first upload. Set `SSH=local`, or omit `SSH`, to set up
the machine running the command. Rerunning it updates only what changed and
keeps the existing host and token.

To install the macOS agent by hand, build it natively with
`cargo build --release --manifest-path agent/Cargo.toml`, provision the host,
then:

```sh
install -d -m 0700 ~/.local/bin ~/.config/stats
install -m 0755 agent/target/release/stats ~/.local/bin/stats
install -m 0600 agent.json token ~/.config/stats/
sed "s|HOME_DIR|$HOME|g" agent/contrib/launchd/xyz.17166969.stats.plist \
  > ~/Library/LaunchAgents/xyz.17166969.stats.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/xyz.17166969.stats.plist
```

Set `tokenFile` in `agent.json` to the absolute path of `~/.config/stats/token`.
Logs go to `~/Library/Logs/stats.log`. Stop it with
`launchctl bootout "gui/$(id -u)/xyz.17166969.stats"`.

macOS has no pressure stall information, so `psi` is reported as
unavailable; the kernel's memory pressure level (normal, warn, critical) is sent
instead, and the dashboard charts the share of time at each. It has no I/O wait, steal time, interface transmit drops, or disk
busy time, so those fields are absent and the dashboard hides disk busy time
for the host. Disks are the physical devices IOKit reports, without disk
images. Network
interfaces default to Ethernet-type `en*` ports, and filesystems to writable
local volumes that Finder shows plus the `/System/Volumes/Data` volume. The
binary links only system libraries and frameworks.

On macOS the agent also reports GPU busy time and GPU energy from IOReport, a
private library it opens at runtime, and whole-system power from the battery's
power telemetry, which updates about once a minute. Either group is reported
unavailable when its source is missing, for example system power on a Mac
without a battery. CPU, DRAM, and Neural Engine energy are not reported: their
IOReport counters do not advance for an unprivileged process.

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
- 400, 404, 413, 422, or a bad URL drops the batch. The agent encodes a
  batch once as a binary STB2 frame and sends the longest prefix of samples
  that fits the 65,536-byte body cap; the rest go back to the front of the
  queue and start the next frame. A sample that cannot be encoded on its own
  is dropped and counted, never retried.
- 410, 415, or a success response that is not a valid STB2 acknowledgment
  covering every sample in the batch is a protocol error: the server does not
  speak ingest v2, so the batch is dropped and the error is logged. An agent
  of this version and a server older than ingest v2 cannot exchange data.
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

Open the Worker's hostname and sign in through Access. The top bar links Hosts
and Projects; the hosts page is `/`. It lists hosts with status chips (online,
stale, no samples, revoked) above the table. A host row shows its status dot,
OS and kernel, CPU model, cores and threads under CPU, disk used of total, and
health-coloured sparklines for CPU, memory, load, and disk space, with disk
read/write and network in/out drawn as mirrored pairs, so the state of the
fleet reads without opening a host.

The Projects page (`#/projects`) lists each configured Cloudflare project with
its requests, 5xx share, CPU, and projected list-price cost for the settled
range, each against the range before it, plus its last deploy and collector
state; a row expands to its request, CPU per request, 5xx, and endpoint or
storage trends. A project page (`#/project/<id>`) opens with a cost
ledger: the monthly list-price cost projected from the last settled hour, its
change from the hour before, this month's spend so far with a dashed
projection to month end, and a tree you can expand from component (Worker, Durable Objects,
D1, R2 storage) to route, method, statement, or bucket, with calls, CPU or wall
time per call, and their change. Health pills for the 5xx share, open errors,
endpoints, and the last deploy sit beside the name. Deployments, errors, the
request explorer, and the Worker, R2, D1, endpoint, Durable Object, and
collector charts are in sections below that start closed. Worker CPU is CPU
time per invocation, not latency,
R2 user errors such as 404s are shown but not scored, and a share or average
is not scored from a five-minute bucket with fewer than 100 events. Projects are configured
in `cloudflare/cloudflare.config.ts`; see
[`docs/architecture.md`](docs/architecture.md#cloudflare-projects).

The host page opens with a status strip and an info button beside the host
name. Hovering or focusing the button opens a card with the CPU model and
topology, memory, OS, kernel, hostname, agent version, and uptime, which the
agent reports with its first upload after an update and then hourly. Below that:

- A status strip with one cell per resource (CPU, memory, load, pressure, swap
  paging, disk busy, filesystem, network faults): the current value, its state,
  and a trend. All eight fit in one row on a desktop, and a cell jumps to its
  chart.
- Charts sit in two-column rows, and the two cards in each row start at the
  same top edge; no graph spans the page.
- CPU (with steal, GPU busy where reported, and a CPU pressure panel) and
  load.
- Power: system and GPU watts, shown only for hosts that report them.
- Memory: RAM and swap in use on an axis scaled to the host's total memory,
  swap paging, and memory pressure (some and full) on one shared time axis.
- Disk and network: throughput and operations or packets with reads and
  receive above the line and writes and transmit below it, busy time (and I/O
  pressure) or drops and errors, and a device or interface table.
- Filesystems: usage over time and one table with capacity and state.
- Block latency and completions, shown only when the collector is configured.

Dotted vertical lines mark reboots, read from a fall in uptime. Mounts of the
same block device (bind mounts, btrfs subvolumes) are listed once. Pressure
panels appear only when the kernel reports PSI; one control selects the
kernel's 10 s, 1 min, or 5 min average for every pressure panel and the status
cell, and each panel shows the coverage-weighted mean and peak for the visible
range. Otherwise one notice says so.

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
it went bad and where it recovered, and a red or orange band across each period
outside its limits. Hovering a band shows the period and its peak; the same
state is carried by the strip by color and an icon, with the word kept for
screen readers only. Series colors mean the same thing on every chart
(in/read blue, out/write aqua, CPU blue, memory aqua, I/O violet), and
the status colors are reserved for state. The limits are in
`cloudflare/src/client/health.ts`. A metric is recovered after five minutes
back inside its limits. The device tables list only devices still reporting.

`make preview` builds the dashboard and serves it on
`http://127.0.0.1:4174/` from the captured fixtures in
`cloudflare/test/ui/captures/`, with the clock frozen at the capture time, so
the UI can be inspected without deploying or signing in through Access.
