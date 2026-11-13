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
Service telemetry, deployment markers, and the application contract:
[`docs/integration.md`](docs/integration.md).
Wire protocol (binary ingest v2): [`docs/protocol.md`](docs/protocol.md). Developer guide: [`AGENTS.md`](AGENTS.md).
Local development: [`make dev` and focused tests](docs/development.md).

## Install the agent

Download the installer from a [release](https://github.com/joshuarli/stats/releases)
and run it as root on Linux (OpenRC or systemd) or as your user on macOS
(launchd). It selects the binary, verifies it against `SHA256SUMS`, and sets up
the service. A missing manifest, missing verifier, malformed checksum or mismatch
stops installation. Verify the release asset before using the manual path below.
Provision the host to get a `hostId` and token, place them in the
config and token files the installer prints, then start the service.

To install manually, use the verified release binary for your platform,
provision the host, then run the following on Linux. Source builds are covered
in [operations](docs/operations.md).

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
the machine running the command. Rerunning keeps the existing host, token and
optional agent settings while updating the endpoint, host ID and token-file path.

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
  "services": [{ "name": "stats-node", "unit": "stats-node.service" }]
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

A Linux build can attach a `block` latency histogram by opting in with the
`block-latency` Cargo feature (embedded probe, no collector file). The probe
is not part of the release build. Build it with `agent/scripts/build-probe.sh`
(needs a clang with the BPF backend; point `LLVM_CLANG` or the first argument
at it), then build the agent with
`STATS_BLOCK_PROBE=/path/to/block_latency.bpf.o cargo build --features block-latency`.
Loading needs tracefs mounted and `CAP_BPF`/`CAP_PERFMON` (or `CAP_SYS_ADMIN`
on older kernels); the agent keeps no other privileges. If the probe fails to
load, or a read fails, `block` is absent from the sample. The probe assumes the
standard `block_rq_issue`/`block_rq_complete` tracepoint layout (dev_t at
offset 8, sector_t at offset 16) and does not parse the format files. macOS
builds never contain or load BPF code. Without the feature the `block` group
is never attached.

`services` is optional and lists at most 16 services, each a `name` (the
service name on the server, 1-32 lowercase letters, digits, or hyphens,
starting with a letter) and a `unit`. On a host with a cgroup v2 hierarchy at
`/sys/fs/cgroup`, each sample reads that unit's `cpu.stat` `usage_usec`,
`memory.current`, `memory.peak` where the kernel has it, and `io.stat` summed
over its devices, and sends them as the `services` group
([`docs/protocol.md`](docs/protocol.md)). The unit picks the cgroup:

| `unit` | cgroup under `/sys/fs/cgroup` |
| --- | --- |
| `openrc.<name>` | `openrc.<name>` |
| `name.service` | `system.slice/name.service` |
| `name@instance.service` | `system.slice/system-name.slice/name@instance.service` (`-` in `name` becomes `\x2d`) |
| `docker-<id>.scope` (Docker with the systemd cgroup driver) | `system.slice/docker-<id>.scope` |
| `libpod-<id>.scope` (Podman), `machine-<name>.scope` (machined) | `machine.slice/<unit>` |
| `a-b.slice` (a slice, or a container started with `--cgroup-parent=/a.slice/a-b.slice` under Docker's cgroupfs driver) | `a.slice/a-b.slice`, one level per `-`; counters include every cgroup below it |

A unit whose cgroup does not exist is sent as unavailable, never zero; a
memory or io controller that is not enabled for it leaves those values
absent. With no cgroup v2 hierarchy, including on macOS, the whole group is
unavailable. A container scope carries the container id, so a recreated
container needs its new scope in the config. `io.stat` is summed over every
device it lists, so stacked devices (device-mapper, md) can count one I/O twice.
Reading these files needs no privileges.

A decoder that does not know the `services` group rejects the whole frame as
`invalid_frame`. Deploy the Worker or Node server that decodes it before you
configure `services` on any agent that reports there.

A Linux agent also sends per-disk `readMs`, `writeMs`, `weightedIoMs`, and
`inFlight` whenever `/proc/diskstats` has them, with no configuration. A decoder
that predates these fields rejects the frame as `invalid_frame` because the disk
head sets reserved bits. Deploy the Worker or Node server first, then update agents.

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
- 410, 415, or a success response that is not a valid STA2 acknowledgment
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

Open the Worker's hostname and sign in through Access, or use the Node
installation's tailnet origin. Hosts are at `/`, projects at `#/projects`, and
services at `#/services`. Host pages show resource status, charts and device
tables; service pages combine deployment markers, host resources and
application telemetry. The Node target has no Cloudflare project collector.

A Cloudflare project page starts with a cost ledger for the settled window,
its change from the previous window, and the available plan-bill projection.
Select a section for deployments, errors, requests or resource charts. Header
health and issue counts stay visible while detailed sections load on demand.
Project configuration lives in `cloudflare/cloudflare.config.ts`; see
[architecture](docs/architecture.md#cloudflare-projects) for collection and
coverage limits.

Host controls:

- Choose 1 h, 6 h, 24 h, 7 d or 90 d, or drag a chart to zoom all charts to the
  same window. The minimum zoom is two samples of the selected storage tier.
- `z` zooms out, `[` and `]` pan, `Escape` resets zoom, `l` toggles live refresh,
  and `/` focuses host search. Live refresh pauses while zoomed or hidden.
- Hover a status band to inspect its interval and peak. Pressure panels share
  the kernel's 10 s, 1 min or 5 min average selector. Host facts appear beside
  the name; device tables show devices still reporting.

A host is online when a sample arrived in the last 45 seconds. Missing values
render as `—` or `unavailable`; optional power, pressure and block-latency
panels depend on the host's capabilities. Linux disk means come from
`/proc/diskstats`; latency distributions require the optional collector.

`make preview` serves captured fixtures at `http://127.0.0.1:4174/` with a
frozen clock, for inspection without deployment or Access login. See
[testing](docs/testing.md) for screenshot verification and
[architecture](docs/architecture.md#dashboard) for refresh and chart behavior.
