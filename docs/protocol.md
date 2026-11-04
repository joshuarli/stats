# Host ingest protocol v2

The agent and the Worker both implement this contract byte for byte.
`fixtures/v2/` is the shared oracle: golden request frames written by the Rust
encoder, golden acknowledgments written by the TypeScript encoder, the
semantic values each frame must decode to, and malformed frames with the
rejection each must produce. `make fixtures` checks the corpus; both test
suites run it. Rationale and measurements are in `docs/binary-ingest.md`.

Version 2 is a hard break. The server accepts no other request format, the
agent sends no other format, and nothing negotiates between them. An agent
built before v2 cannot deliver to a v2 server; `POST /ingest/v1/batches`
answers `410 Gone`.

Agent → server batches and success acknowledgments are binary. Stored sample
payloads, rollups, and the STC1 dashboard-history responses are unchanged:
the server converts each decoded sample to the same canonical JSON it stored
under v1, and every rate, gap, duplicate, and rollup rule below works on those
values.

## Transport

HTTPS with system trust roots. The agent sends

```
POST /ingest/v2/batches
Authorization: Bearer nft_<43 base64url chars>
Content-Type: application/vnd.stats.ingest.v2
```

with a body of at most 65,536 bytes and no `Content-Encoding` (or
`identity`). A batch contains 1–16 samples. A successful response is `200`
with `Content-Type: application/vnd.stats.ingest-ack.v2` and an STA2 body.
Every other status carries a small JSON error `{ "error": { "code", "message" } }`;
the status and `Retry-After` are authoritative.

## Encoding primitives

- **u8**: one byte.
- **varint**: unsigned LEB128, low seven bits first, high bit set on every
  byte but the last. At most 10 bytes; the 10th byte, when present, is `0x00`
  or `0x01`. A varint is canonical: its last byte is non-zero unless the whole
  varint is the single byte `0x00`. Every value in `0 ..= 2^64-1` is
  representable exactly. Overlong, non-canonical, and over-u64 varints reject
  the frame.
- **str(max)**: a varint byte length `L` with `1 <= L <= max`, then `L` bytes
  of strict UTF-8 (no overlong forms, no surrogates). The length is checked
  against `max` before any byte is read.
- **id16**: 16 raw bytes.
- **mask**: a u8 or varint whose undefined bits must be zero.

There are no fixed-width multibyte integers. Counters, gauges, timestamps,
and fixed-point values are all varints.

Fixed-point values are integers in their unit: load averages are
**thousandths** (`0.120` is `120`), PSI averages are **hundredths of a
percent** (`1.25` is `125`). Neither side converts them through floating
point.

## Request frame (STB2)

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 4 | magic `53 54 42 32` (`STB2`) |
| 4 | 1 | version, `0x02` |
| 5 | 1 | flags: bit 0 `SYSTEM`; bits 1–7 reserved |
| 6 | 16 | host id |
| 22 | 16 | boot id |
| 38 | 1 | sample count `n` |
| 39 | … | system record, when `SYSTEM` is set |
| … | … | `n` sample records |

The frame ends exactly after the last sample record.

**Host id.** `hostId` is `h_` followed by 32 lowercase hex digits; the 16
bytes are those digits read as pairs in order. `h_0123…cdef` is
`01 23 … cd ef`. The server renders them back to the textual form.

**Boot id.** The kernel boot UUID (`/proc/sys/kernel/random/boot_id` or
`kern.bootsessionuuid`). The 16 bytes are the 32 hex digits of the textual
UUID in order, ignoring hyphens (RFC 9562 network byte order). The server
renders them as lowercase `8-4-4-4-12`.

### System record

Static host facts. The agent attaches the record to its first upload after it
starts and then at most once an hour; only a delivered upload resets that
clock. The server keeps the latest record per host and the time it arrived.

| Field | Encoding | Semantic bound |
| --- | --- | --- |
| mask | u8: bit 0 `os`, 1 `model`, 2 `cores`, 3 `sockets`, 4 `maxMhz`; bits 5–7 reserved | |
| agent | str(128) | 1–32 characters |
| hostname | str(256) | 1–64 characters |
| os | str(512), when bit 0 | 1–128 characters, `PRETTY_NAME` from `os-release` |
| kernel | str(256) | 1–64 characters |
| arch | str(64) | 1–16 characters |
| threads | varint | 1–4096 |
| model | str(512), when bit 1 | 1–128 characters |
| cores | varint, when bit 2 | 1–4096, distinct physical id and core id pairs |
| sockets | varint, when bit 3 | 1–256, distinct physical ids |
| maxMhz | varint, when bit 4 | 1–100000, `cpuinfo_max_freq` |

A character is a Unicode scalar value. Strings contain no control characters
(U+0000–U+001F, U+007F–U+009F). A fact the host does not expose is absent,
never zero or empty.

### Sample record

| Field | Encoding |
| --- | --- |
| seq | varint, `floor(monoMs / 1000)` |
| atMs | varint, epoch milliseconds |
| monoMs | varint, monotonic milliseconds since boot |
| present | varint group mask |
| unavailable | varint group mask |
| groups | one record per set `present` bit, in bit order |

Group bits:

| Bit | Group | May be unavailable |
| --- | --- | --- |
| 0 | `cpu` | yes |
| 1 | `load` | yes |
| 2 | `mem` | yes |
| 3 | `uptimeMs` (unavailable name `uptime`) | yes |
| 4 | `cpuCount` | no |
| 5 | `disks` | yes |
| 6 | `nets` | yes |
| 7 | `psi` | yes |
| 8 | `filesystems` | yes |
| 9 | `block` | no |
| 10 | `gpu` | yes |
| 11 | `power` | yes |

Bits 12 and above are reserved in both masks; bits 4 and 9 are reserved in
`unavailable`. A bit set in both masks rejects the frame. A group in neither
mask is missing. A group in `unavailable` was attempted and could not be read.
A device group present with count 0 is present and empty. A counter present
with value 0 is zero.

Each group record:

**cpu** — head u8: bit 0 `iowait`, bit 1 `steal`, bit 2 `DELTA`; bits 3–7
reserved. Then `user`, `system`, `idle`, `iowait` (bit 0), `steal` (bit 1),
`total`, each a counter varint.

**load** — `one`, `five`, `fifteen`: thousandths varints.

**mem** — head u8: bit 0 `SWAP`, bit 1 `PRESSURE`, bit 2 `DELTA`; bits 3–7
reserved; `DELTA` requires `SWAP`. Then `total`, `available`, `swapTotal`,
`swapFree` (gauge varints, bytes); when `SWAP`, `swapIn` and `swapOut`
(counter varints, cumulative bytes paged in from and out to swap); when
`PRESSURE`, a u8 level: `0` normal, `1` warn, `2` critical, other values
reject the frame.

**uptimeMs** — head u8: bit 0 `DELTA`; bits 1–7 reserved. Then the counter varint.

**cpuCount** — varint.

**disks** — count varint, 0–16, then per disk:

- ref varint. `0` defines a new disk dictionary entry inline: `major` varint,
  `minor` varint, `name` str(32). The entry's index is the number of disk
  entries defined before it in this frame. A ref `r >= 1` names entry `r - 1`,
  which must already be defined.
- head u8: bit 0 `ioMs`, bit 1 `DELTA`; bits 2–7 reserved.
- `reads`, `readSectors`, `writes`, `writeSectors`, `ioMs` (bit 0): counter varints.

**nets** — count varint, 0–16, then per interface:

- ref varint; `0` defines an interface entry inline: `name` str(15).
- head u8: bit 0 `txDrops`, bit 1 `DELTA`; bits 2–7 reserved.
- `rxBytes`, `rxPackets`, `rxDrops`, `rxErrors`, `txBytes`, `txPackets`,
  `txErrors`, `txDrops` (bit 0): counter varints.

**psi** — mask u8: bit 0 `cpu`, bit 1 `memory`, bit 2 `io`; bits 3–7
reserved; zero rejects the frame. For each set resource in bit order:

- head u8: bit 0 `FULL`, bit 1 `DELTA`; bits 2–7 reserved.
- `some10`, `some60`, `some300` (hundredths varints), `total` (counter varint,
  microseconds).
- When `FULL`: `full10`, `full60`, `full300` (hundredths), `fullTotal` (counter).

`DELTA` applies to `total` and `fullTotal`; the averages are always absolute.

**filesystems** — count varint, 0–16, then per filesystem:

- ref varint; `0` defines an entry inline: `path` str(255), then a type u8
  indexing `ext2 ext3 ext4 xfs btrfs f2fs vfat exfat ntfs3 zfs tmpfs overlay
  apfs` (0–12; other values reject the frame).
- `total`, `available`: gauge varints, bytes (`available` uses `f_bavail`).

**block** — 16 bucket varints, then `count`, `totalUs`, `minUs`, `maxUs`.
All absolute: the histogram is an interval measurement, not a counter.

**gpu** — head u8: bit 0 `DELTA`; bits 1–7 reserved. Then `active`, `total`
counter varints: cumulative GPU residency in 24 MHz ticks, `active` outside
the off state and `total` across all states.

**power** — head u8: bit 0 `GPU_NJ`, bit 1 `SYSTEM`, bit 2 `DELTA`; bits 3–7
reserved; bits 0 and 1 both clear rejects the frame. Then `gpuNj` (bit 0,
cumulative GPU energy in nanojoules), then `systemMwSum` and `systemReadings`
(bit 1, a running sum of whole-system power readings in milliwatts and the
count of readings). All counter varints.

Paired fields (`swapIn`/`swapOut`, the four PSI `full` values,
`systemMwSum`/`systemReadings`, GPU `active`/`total`) share one presence bit,
so half a pair cannot be encoded.

### Dictionaries

Dictionaries are batch-local and built in wire order. There is one per device
kind (disks, interfaces, filesystems); each starts empty in every frame. An
entry is defined at its first use and referenced afterwards, so a frame cut
after any sample is still a complete, decodable frame for that prefix.

- Defining an entry identical to an existing entry of the same kind rejects
  the frame. Two entries may share a device identity with different metadata:
  a disk renamed mid-batch gets a second entry with the same `major:minor`; a
  remounted filesystem gets a second entry with the same path and the new type.
- Device identity is `major:minor` for disks, the name for interfaces, and the
  path for filesystems. Two records with the same identity in one sample reject
  the frame.
- The union of entries across a batch is bounded only by the record counts:
  at most 16 per sample, so at most 256 per kind.

### Counter deltas

A counter record (the `cpu` group, the `mem` swap pair, `uptimeMs`, each disk,
each interface, each PSI resource, `gpu`, `power`) is either absolute or, with
its `DELTA` bit, a set of differences against the **immediately preceding
sample record in this frame**. Its predecessor is the record of the same group
— and, for devices, the same identity; for PSI, the same resource — in that
previous sample. A delta record requires a predecessor with the same optional
fields present (`iowait`/`steal`, `ioMs`, `txDrops`, `FULL`, `GPU_NJ`/`SYSTEM`).
`DELTA` without such a predecessor rejects the frame.

The decoder reconstructs each counter as `predecessor + delta`; a sum above
2^64-1 rejects the frame. Deltas are non-negative, and zero is a valid delta.
Reconstruction runs over every structurally decoded sample in wire order,
before any sorting and before semantic validation, so a sample later rejected
for a semantic reason still serves as its successor's predecessor.

The encoder sends a record as a delta exactly when a predecessor with the same
shape exists and no counter in the record is below its predecessor's value;
otherwise it sends the record absolute. That covers the first sample, a group
or device that disappeared and returned, an optional counter that appeared,
and a counter that regressed. A decoder accepts an absolute record wherever a
delta would also have been valid.

Nothing outside the frame is a predecessor: not an earlier request, not the
latest stored sample, not an acknowledgment. Every frame decodes on its own
after a server restart, agent restart, retry, or re-batching. Gauges,
fixed-point averages, the block histogram, and `seq`, `atMs`, `monoMs` are
always absolute; wall-clock regressions and out-of-order samples are
representable as is.

The decoder hands the reconstructed absolute values to validation and
storage. An absolute record after a regression therefore carries the lower
value, and the rate rules below see the regression as a gap.

## Validation

Decoding is bounded: every count and length is checked against its limit
before anything is allocated or iterated. Validation then runs in two levels.

**Frame rejections** reject the whole request with `400` before anything is
written. The code is:

- `invalid_frame`: wrong magic; non-zero reserved flag or mask bits; unknown
  enum values; a truncated field or record; an overlong, non-canonical, or
  over-u64 varint; a string length outside its bound; invalid UTF-8; a device
  count above 16; an out-of-range dictionary reference; a duplicate dictionary
  entry; a repeated device identity in one sample; a bit set in both
  `present` and `unavailable`; an empty PSI or power mask; a `DELTA` without
  a predecessor; delta overflow; bytes after the last sample.
- `unknown_version`: the magic is `STB2` and the version byte is not 2.
- `invalid_batch`: a sample count outside 1–16; a system record outside its
  semantic bounds; a dictionary entry outside its semantic bounds: a disk
  `major` above 4095 or `minor` above 1048575, a disk name outside
  `[A-Za-z0-9._-]{1,32}`, an interface name outside `[A-Za-z0-9_.:@-]{1,15}`,
  a filesystem path that does not start with `/` or contains U+0000.
- `too_large`: a body over 65,536 bytes, counted at the byte-reading boundary,
  so a streamed body without `Content-Length` is cut off at the cap.

**Sample rejections** reject one sample with `invalid_sample`; the others in
the batch proceed:

- `seq`, `atMs`, or `monoMs` above 2^53-1.
- No metric group present (`cpuCount` alone is not a metric group).
- `load` above 999999.999 (999999999 thousandths); a PSI average above
  999999.99 (99999999 hundredths).
- `cpuCount` outside 1–4096.
- `block`: `count` is not the sum of the 16 buckets; a zero `count` with a
  non-zero `totalUs`, `minUs`, or `maxUs`; a non-zero `count` with
  `minUs > maxUs` or `maxUs > totalUs`.
- `atMs` more than 5 minutes after server receipt; `atMs` more than 48 hours
  before it is `too_old` instead.

Then storage: a stored `(hostId, bootId, seq)` with identical canonical
content is a duplicate and not an error; the same key with different content
is a `conflict`. A sample whose `monoMs` matches a stored sample of the same
boot with a different `seq` is `invalid_sample`.

The Worker rejects a request before the Durable Object sees it, in order:
wrong path or method (405), a missing or malformed bearer credential (401),
a media type other than `application/vnd.stats.ingest.v2` (415, ignoring
parameters and case), a `Content-Encoding` other than `identity` (415), a
declared `Content-Length` above the cap (413). Inside the object: the media
and encoding checks again, the bounded body read (413), frame decoding (400),
the credential against the host id in the frame (`unauthorized`, 401; a
token issued for another host is `unauthorized`), the rate limit
(`rate_limited`, 429 with `Retry-After: 60`, six requests per host per
minute), then each sample.

The canonical content compared for duplicates is the decoded, reconstructed
sample rendered as the stored JSON: u64 values as decimal strings, load as
`d.ddd`, PSI averages as `d.dd`, `cpuCount` as a number, `unavailable` as
group names in bit order, devices in wire order, keys sorted. A sample sent
first in one batch and later in another, as an absolute record or a delta,
with different dictionary indexes, or after a batch split, compares equal.

## Success acknowledgment (STA2)

A batch with at least one accepted or duplicate sample returns `200`:

| Field | Encoding |
| --- | --- |
| magic | `53 54 41 32` (`STA2`) |
| version | u8 `0x02` |
| accepted | varint |
| duplicates | varint |
| rejected | varint `r`, 0–16 |
| `r` entries | `seq` varint, then a code u8 |

Rejection codes: `1` `invalid_sample`, `2` `too_old`, `3` `conflict`. Other
values are invalid. The body ends after the last entry.

Every sample in the request is counted exactly once, so
`accepted + duplicates + r` equals the request's sample count, and each
rejected `seq` is a `seq` the request carried (as many times as it carried
it). The agent treats a `200` with another media type, a malformed body, an
unknown code, a count mismatch, or an unknown `seq` as a failed upload, never
as delivery.

If nothing was accepted or duplicated, the response is `400` with
`{ "error": { "code", "message" }, "rejected": [{ "seq": "<decimal>", "code": "<name>" }] }`.
Rejections never include credentials, token hashes, or request bodies.

## Agent behavior

- Batches: two samples normally, up to 16 when more than two are queued.
- The agent encodes a batch once. It writes samples in order and keeps the
  longest prefix whose frame fits in 65,536 bytes; what it measured is what
  it sends. Samples after the prefix return to the front of the queue in
  order and start their own frame, with their own absolute bases and
  dictionaries.
- A sample that cannot be encoded on its own is dropped and counted; it is
  never retried.
- `429` waits for `Retry-After`; `401`/`403` reread the token file and retry
  after a minute; network errors, timeouts, and `5xx` back off and retry.
  `400`, `404`, `413`, and `422` drop the batch. `410`, `415`, and a malformed
  success acknowledgment are protocol errors: the server does not speak this
  protocol or did not answer in it, so the batch is dropped and the error is
  logged as such rather than retried as a temporary failure.

## Identity, clock, and rates

- `bootId` changes on reboot. `monoMs` is the interval clock; wall-clock
  jumps do not create or destroy rates.
- Online means a sample was received by the server within 45 seconds. Display
  time uses `atMs`; freshness uses server receipt time. Neither is trusted for
  authorization.
- Rates use consecutive samples of the same boot with strictly increasing
  `monoMs` and non-decreasing counters. Counter regression is a gap, never a
  negative rate. No offline period is interpolated.
- CPU constants: `user` is user+nice, `system` is system+irq+softirq; `total`
  is their sum with `idle` and, when present, `iowait` and `steal`. CPU
  percentages are counter deltas divided by the delta of `total`.
- macOS exposes neither `iowait` nor `steal`, an interface's transmit drops,
  nor disk busy time, so its agent omits `iowait`, `steal`, `txDrops`, and
  `ioMs`, and the Worker reports no value for them. Disk sectors are always
  512-byte kernel sectors.
- Swap activity rates are `swapIn` and `swapOut` deltas divided by the
  monotonic interval. A sample without the pair, or a regressed counter, has
  no swap rate for that interval; the pair is absent when `/proc/vmstat`
  cannot be read, never zero.
- GPU busy percent is the `active` delta divided by the `total` delta times
  100. GPU watts are the `gpuNj` delta divided by the monotonic interval in
  milliseconds and by 1e6. System watts are the `systemMwSum` delta divided by
  the `systemReadings` delta and by 1000; the source publishes about once a
  minute, so an interval in which `systemReadings` did not advance has no
  system watts, never zero. Rollups sum the deltas, so a bucket's system watts
  is the mean of the readings that arrived in it.
- Disk and network rates are deltas divided by the monotonic interval. Disk
  bytes use 512-byte sectors. `ioMs / interval` is busy time and may exceed
  100% when the device has concurrent I/O.
- A device or interface that disappears and returns resumes the same series
  with a gap: the first sample after it returns has no rate because no counter
  interval exists. Its name is display text, not identity.
- `block` is an optional interval histogram of block-layer request latency in
  microseconds. Bucket upper bounds are `100`, `250`, `500`, `1000`, `2500`,
  `5000`, `10000`, `25000`, `50000`, `100000`, `250000`, `500000`, `1000000`,
  `2500000`, `5000000`, and overflow. `totalUs`, `minUs`, and `maxUs` are the
  sum, minimum, and maximum observed latency. The group is absent when the
  optional probe is not configured; it is never synthesized.
