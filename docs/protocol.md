# Wire protocol v1

The agent and the Worker both enforce this contract. `fixtures/v1/` is the shared accept/reject oracle; `make fixtures` checks it, and both test suites run every fixture. JSON with decimal strings keeps every u64 exact
at both ends; change the encoding only for a measured payload problem that a
new format solves without losing that exactness.

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
them silently. JSON numbers are used only for `v`, `cpuCount`, and the `system`
integers.

## System details

A batch may carry one optional `system` object: static facts about the host.
The agent attaches it to its first upload after it starts and then at most once
an hour, and only a delivered upload resets that clock. The server keeps the
latest object per host and the time it arrived.

| Field | Required | Shape |
| --- | --- | --- |
| `agent` | yes | agent version, 1–32 characters |
| `hostname` | yes | kernel node name, 1–64 characters |
| `os` | no | `PRETTY_NAME` from `os-release`, 1–128 characters |
| `kernel` | yes | kernel release, 1–64 characters |
| `arch` | yes | machine architecture, 1–16 characters |
| `cpu` | yes | `threads` (integer 1–4096) and optionally `model` (1–128 characters), `cores` (1–4096, distinct physical id and core id pairs), `sockets` (1–256, distinct physical ids), `maxMhz` (1–100000, `cpuinfo_max_freq`) |

Strings contain no control characters. Unknown fields at any level make the
whole batch invalid. A field the kernel does not expose is absent, never zero
or an empty string.

## Sample

| Field | Required | Shape |
| --- | --- | --- |
| `seq` | yes | decimal string, at most 2^53-1; `floor(monoMs / 1000)` |
| `atMs` | yes | epoch milliseconds, at most 2^53-1 |
| `monoMs` | yes | monotonic milliseconds since boot, at most 2^53-1 |
| `unavailable` | no | array of `cpu`, `load`, `mem`, `uptime`, `disks`, `nets`, `psi`, `filesystems`; at most 8, unique |
| `cpu` | no | `user`, `system`, `idle`, `total`, and optionally `iowait` and `steal`, each a u64 string |
| `load` | no | `one`, `five`, `fifteen`, each a fixed 3-decimal string |
| `mem` | no | `total`, `available`, `swapTotal`, `swapFree`, each a byte string; optionally `swapIn` and `swapOut` together, cumulative bytes paged in from and out to swap since boot (`pswpin` and `pswpout` from `/proc/vmstat` times the page size), each a u64 string |
| `uptimeMs` | no | u64 string |
| `cpuCount` | no | integer 1–4096 |
| `disks` | no | 0–16 objects: `id` (`major:minor`, Linux `dev_t` bounds: major at most 4095, minor at most 1048575), `name` (1–32 chars), `reads`, `readSectors`, `writes`, `writeSectors`, and optionally `ioMs` |
| `nets` | no | 0–16 objects: `id` (interface name), `rxBytes`, `rxPackets`, `rxDrops`, `rxErrors`, `txBytes`, `txPackets`, `txErrors`, and optionally `txDrops` |
| `psi` | no | optional `cpu`, `memory`, `io`; each has `some10`, `some60`, `some300` (fixed 2-decimal percent) and `total` (microseconds); each may also have all four of `full10`, `full60`, `full300`, `fullTotal` |
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
their sum with `idle` and, when present, `iowait` and `steal`. macOS exposes
neither `iowait` nor `steal`, an interface's transmit drops, nor disk busy
time, so its agent omits `iowait`, `steal`, `txDrops`, and `ioMs`, and the
Worker reports no value for them. Disk sectors are always 512-byte
kernel sectors. Filesystem `available` uses `f_bavail` (available to an
unprivileged process). `psi` averages are percentages; `total` is microseconds.

## Validation and response

The Worker rejects a POST without a token-shaped bearer credential or with an
oversized declared body before the Durable Object sees it. Inside the object
the checks run in order: method (405), content type (415), body size
(`too_large`, 413), JSON (`invalid_json`), batch keys (`invalid_batch`), version
(`unknown_version`), host and boot identity and sample count (`invalid_batch`),
credential (`unauthorized`, 401), rate limit (`rate_limited`, 429 with
`Retry-After: 60`, six requests per host per minute), then each sample
(`invalid_sample` with a `seq` when parseable). A token issued for another host
is `unauthorized`. Observed timestamps more than 5 minutes in the future are
`invalid_sample`; older than 48 hours are `too_old`.

A duplicate `(hostId, bootId, seq)` with identical canonical bytes is counted
as a duplicate and is not an error. The same key with different bytes is a
`conflict`. A batch with at least one accepted or duplicate sample returns 200:

```json
{ "v": 1, "accepted": 1, "duplicates": 1, "rejected": [{ "seq": "1000002", "code": "invalid_sample" }] }
```

If nothing was accepted or duplicated, the response is 400 with
`{ "error": { "code": "...", "message": "..." } }`. Rejections never include
credentials, token hashes, or request bodies.

## Identity, clock, and rates

- `bootId` changes on reboot. `monoMs` is the interval clock; wall-clock jumps
  do not create or destroy rates.
- Online means a sample was received by the server within 45 seconds. Display
  time uses `atMs`; freshness uses server receipt time. Neither is trusted for
  authorization.
- Rates use consecutive samples of the same boot with strictly increasing
  `monoMs` and non-decreasing counters. Counter regression is a gap,
  never a negative rate. No offline period is interpolated.
- CPU percentages are counter deltas divided by the delta of `total`.
- Swap activity rates are `swapIn` and `swapOut` deltas divided by the
  monotonic interval. A sample without the pair, or a regressed counter, has no
  swap rate for that interval; the pair is absent when `/proc/vmstat` cannot be
  read, never zero.
- Disk and network rates are deltas divided by the monotonic interval. Disk
  bytes use 512-byte sectors. `ioMs / interval` is busy time and may exceed
  100% when the device has concurrent I/O.
- A device or interface id that disappears and returns resumes the same series
  with a gap: the first sample after it returns has no rate because no counter
  interval exists. Its name is display text, not identity.

