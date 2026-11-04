# Binary host ingest

Host telemetry moved from minified JSON batches (protocol v1) to compact
binary STB2 batches with STA2 acknowledgments (protocol v2). The byte layout,
validation rules, and agent behavior are specified only in
[`protocol.md`](protocol.md); this file records why the format looks the way
it does, how it was measured, and what it does not do.

What changed and what did not:

- Agent → server batches are binary, and success acknowledgments are binary.
  There is no JSON ingest path, fallback, or negotiation; `/ingest/v1/batches`
  answers `410 Gone`.
- Stored sample payloads are unchanged: the server converts each decoded
  sample to the same canonical JSON it stored under v1, and duplicates,
  conflicts, rates, rollups, retention, and history read that text.
- Dashboard history still uses the STC1 frame and its compression.
- The metrics collected, sampling every 15 s, two samples per upload (16 for a
  backlog), the 16-sample and 65,536-byte caps, requests per host per day, and
  rows written are unchanged.

## Design

The batches are small and change slowly, so the format spends its bytes on
values and none on names or structure:

- **Varints and masks.** Every integer is a canonical LEB128 varint; field
  presence is a bit in a per-group head byte, and each sample carries one
  group-presence mask and one unavailable mask. Paired fields share one bit,
  so half a pair cannot be encoded. Identities are their 16 raw bytes.
- **Exact numbers.** u64 values travel as varints and stay `u64` in Rust and
  `bigint` in TypeScript until a checked bound; load and PSI averages are
  integer thousandths and hundredths, never floats.
- **Inline batch-local dictionaries.** A disk, interface, or filesystem is
  defined the first time a frame uses it and referenced by index afterwards,
  so a device name costs its bytes once per frame. Because definitions are
  inline and deltas point only backwards, a frame cut after any sample is the
  complete frame for that prefix: the agent encodes once, keeps the longest
  prefix under the cap, and sends exactly what it measured.
- **Deltas inside the frame only.** A counter record may be the difference
  from the previous sample of the same frame. Nothing outside the request is
  ever a base, so retries, restarts, splits, and server restarts need no
  shared state. A counter that regressed is sent absolute, and the decoder
  reconstructs absolute values before validation, so the storage layer still
  sees the regression and records a gap.
- **One normalization boundary.** The Worker decodes into typed bigint values
  (`src/ingest/frame.ts`), applies the per-sample domain checks, and converts
  to the stored JSON shape in one place (`src/ingest/sample.ts`). The storage
  code is untouched.

Rejected alternatives: request compression (adds a dependency and a second
mode, and the binary frame is already smaller than gzip-9 JSON for normal
uploads), Protobuf/FlatBuffers/MessagePack (a schema compiler or generic
object model for a fixed schema with one producer and one consumer), and
cross-request deltas or session dictionaries (they would make a request
undecodable without server memory).

## Method

All numbers below were recorded on 2026-11-04 on an Apple M5 Max (18 cores,
macOS 27.0, arm64) with Node v26.12.1 and Rust nightly-2026-09-15 (rustc
1.100.0), at commit `5a94fa3` against the baseline `9ee3319` checked out in a
separate worktree. The machine was shared with another session's
CPU-bound job (about 600% CPU, load average 8–10 of 18 cores) for every
timing run. The runs are interleaved, so both sides saw the same load, but
treat the timings as indicative: they are not a quiet-machine measurement and
not production CPU.

```sh
make fixtures                                   # byte accounting and budgets
BASELINE_WORKTREE=.work/wt/baseline make ingest-bench
```

- **Bytes** come from the golden frames in `fixtures/v2/frames/`, which
  `make agent-test` requires to equal the agent encoder's output. v1 bytes are
  the minified v1 JSON batch for the same samples. gzip is computed offline
  with Node's zlib; it is a comparison, not a protocol option.
- **Rust encoding** (`agent/examples/ingest_bench.rs`, release build): 200
  warmup calls, then 15 interleaved rounds of 2,000 calls per encoder;
  median and range of the per-call mean across rounds. Allocations are
  counted by a counting global allocator for one call. The legacy encoder is
  the v1 JSON serialization of the same samples, including the u64→decimal
  formatting the v1 collector did when it built strings.
- **TypeScript ingest work** (`bench/ingest-decode.ts`): the complete work
  from body to stored strings on each side. v1 is the original `parseBatch`
  (kept benchmark-only in `bench/legacy-v1/protocol-v1.ts`, JSON parse plus
  validation) followed by `canonicalJson` of every sample. v2 is
  `decodeFrame`, `validateSample` (domain checks and normalization), and
  `canonicalJson`. Each case is calibrated to at least 50 ms per round, then
  15 interleaved rounds; median and range. Both sides produce identical
  stored bytes for every workload (checked in the run).
- **End to end** (`cloudflare/bench/ingest.workerd.ts` and its v1 twin
  `bench/legacy-v1/ingest-v1.workerd.ts`): 300 distinct two-sample uploads
  after 30 warmups through `SELF.fetch` into the Worker, the Durable Object,
  SQLite, and the rollup rebuild under local workerd. workerd clamps timers to
  1 ms, so the mean over 300 requests is the useful figure.

Workload labels: **fixture-derived** batches are the v1 fixtures (realistic
Linux and macOS values; not live host captures); **synthetic** batches are
generated by `scripts/fixture-sources.mjs` from seeded random variation;
**boundary** batches exercise limits. No live host capture was measured.

## Results

Request bodies (HTTP headers excluded):

| Workload | Label | Samples | v1 JSON | JSON gzip -9 | STB2 absolute | STB2 | vs JSON | Budget |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Linux normal upload | fixture-derived | 2 | 3,332 | 875 | 536 | 485 | -85.4% | 520 |
| macOS normal upload | fixture-derived | 2 | 1,989 | 674 | 377 | 342 | -82.8% | 370 |
| Linux single sample | fixture-derived | 1 | 1,799 | 709 | 321 | 321 | -82.2% | 345 |
| macOS single sample | fixture-derived | 1 | 1,052 | 551 | 225 | 225 | -78.6% | 240 |
| System-info upload | fixture-derived | 1 | 509 | 336 | 175 | 175 | -65.6% | 190 |
| Linux normal + system | fixture-derived | 2 | 3,556 | 1,017 | 637 | 586 | -83.5% | 630 |
| Linux 16-sample backlog | synthetic | 16 | 27,222 | 4,193 | 3,999 | 3,335 | -87.7% | 3,570 |
| macOS 16-sample backlog | synthetic | 16 | 15,185 | 2,463 | 2,533 | 2,068 | -86.4% | 2,210 |
| Counter reset | fixture-derived | 2 | 3,023 | 772 | 458 | 454 | -85.0% | |
| Missing/unavailable/empty groups | synthetic | 5 | 992 | 386 | 159 | 159 | -84.0% | |
| Large counters (2^53+, u64::MAX) | boundary | 3 | 900 | 312 | 252 | 186 | -79.3% | |
| Device churn, 16/sample, 80 in union | synthetic | 5 | 29,805 | 3,243 | 5,950 | 5,950 | -80.0% | |
| High cardinality, 16 devices x 3 kinds | synthetic | 16 | 95,119 | 9,100 | 13,427 | 13,427 | -85.9% | 14,400 |

The 50% target for the normal two-sample Linux and macOS uploads is met with
margin (-85.4% and -82.8%). The budgets in `fixtures/v2/manifest.json` are
checked by `make fixtures` and sit about 7% above today's sizes. The
high-cardinality backlog does not fit one v1 request at all (95,119 bytes
against the 65,536-byte cap); v2 sends it in one 13,427-byte request.

Batch-local deltas against absolute-only frames: -9.5% for the Linux normal
upload, -9.3% macOS, -16.6% and -18.4% for the 16-sample backlogs, -26.2% for
the large-counter case, and 0% where nothing has a predecessor (single
samples) or every device churns. The saving is real but modest; it is most of
the gap between STB2 and gzip-9 JSON on backlogs.

Success acknowledgments: 8 bytes for a full acceptance (v1 JSON: 49), 12 bytes
with one rejection (v1: 89).

Projected ingress for one host at the default cadence (2,880 two-sample
uploads a day, request bodies only): 1.40 MB/day with STB2 against 9.60 MB/day
with v1 JSON. Requests per day, rows per host (11,520 raw, 10,080 one-minute,
720 hourly at the retention limits), and stored bytes (about 1,986 bytes of
canonical sample and delta JSON per raw row for the Linux fixture) are the
same under both protocols; `make fixtures` prints them separately.

Rust encoding, ns per batch, median [min–max], and allocations per call:

| Workload | STB2 | STB2 absolute | v1 JSON | Allocations STB2 / v1 |
| --- | --- | --- | --- | --- |
| Linux normal (2) | 750 [709–816] | 748 [683–815] | 7,802 [7,615–8,920] | 11 / 218 |
| macOS normal (2) | 508 [462–528] | 468 [419–494] | 3,578 [3,517–4,069] | 11 / 90 |
| System upload (1) | 183 [172–197] | 181 [171–199] | 579 [556–675] | 2 / 13 |
| Linux backlog (16) | 6,443 [6,327–6,766] | 5,463 [5,390–5,673] | 64,535 [62,744–65,664] | 56 / 1,850 |
| macOS backlog (16) | 4,030 [3,762–4,286] | 3,434 [3,242–3,538] | 27,891 [26,653–28,371] | 56 / 681 |
| High cardinality (16) | 56,724 [55,378–58,610] | 48,875 [48,008–50,708] | 154,193 [152,593–155,997] | 70 / 4,924 |

Encoding is about ten times cheaper than the JSON it replaced, but it was
already microseconds every 30 seconds, so this does not change the agent's
measurable CPU. The delta search costs 16–18% more encode time than
absolute-only on backlogs.

TypeScript ingest work, µs per request, median [min–max]:

| Workload | v1 JSON parse + validate + canonicalize | STB2 decode + validate + normalize + canonicalize |
| --- | --- | --- |
| Linux normal (2) | 41.1 [40.0–43.3] | 35.3 [33.7–37.5] |
| macOS normal (2) | 22.2 [21.7–22.7] | 18.5 [18.0–19.8] |
| System upload (1) | 4.4 [4.1–4.6] | 4.9 [4.7–5.2] |
| Linux backlog (16) | 343.4 [331.3–356.1] | 286.6 [272.2–293.1] |
| macOS backlog (16) | 169.0 [164.0–176.8] | 140.8 [135.9–146.9] |
| High cardinality (16) | not sendable in one v1 request | 915.7 [871.1–969.1] |

The complete server-side codec work is about 15% faster for sample batches
and slightly slower for the tiny system-only batch. A second run at lower
load measured 6–7% lower absolute times on both sides and the same ratios
(Linux normal 37.5 against 32.6 µs; Linux backlog 322.6 against 269.2 µs);
the Rust ratios repeated as well (Linux normal 691 against 7,224 ns). It is tens of
microseconds per request either way.

End to end under local workerd, mean over 300 two-sample uploads: 3.03 ms
(STB2) against 3.11 ms (v1 JSON) in the first run, and 1.99 ms against
1.90 ms in a second run at lower load, with equal medians and p90 within each
run. The order flips between runs and SQLite writes and the rollup rebuild
dominate, so there is no measurable difference. This says nothing about production CPU billing, which was not
measured.

Artifact sizes: the static agents shrank by 98,472 bytes (x86_64 musl,
-3.4%) and 91,688 bytes (aarch64 musl, -3.6%), and the macOS arm64 agent by
78,000 bytes (-3.0%). The Worker bundle grew by 15,420 bytes (+8.8%; +3,877
gzipped). No dependency was added; `deser-value` moved to dev-dependencies.
`stats --bench 20 100` showed the same collection latency (about 1.0–1.3 ms)
and max RSS (about 9.5 MB) for both agents on this development host, which
the agent benchmark method does not accept as evidence either way.

## Tradeoffs and limits

- **High device churn favors gzip.** When most device names in a frame are
  new and long (the synthetic churn and high-cardinality cases), gzip-9 JSON
  is smaller than STB2 (3,243 against 5,950 and 9,100 against 13,427 bytes),
  because the dictionary removes repetition across samples but not the
  similarity between different names. STB2 is still 80–86% smaller than the
  uncompressed JSON it replaced.
- **Deltas save little on normal uploads.** About 50 bytes on a two-sample
  upload, for an encoder and decoder that must agree on predecessors and
  record shapes. They are kept because they are cheap to verify with the
  corpus and pay 16–18% on backlogs.
- **No server CPU or billing claim.** Codec time fell slightly in Node and
  end-to-end time did not change measurably in local workerd. Rows written
  and stored bytes are unchanged by design.
- **The cutover is a hard break.** Old agents and the new server, or new
  agents and an old server, store nothing. `docs/operations.md` has the
  coordinated procedure and rollback.
- **Rejection classes moved.** A disk, interface, or filesystem identity
  outside its bounds now rejects the frame (`invalid_batch`) instead of each
  sample that carried it, because the identity lives in the batch dictionary.
  A frame-level rejection drops the batch, as every-sample rejection did
  before. Every per-sample rejection now names its `seq`, and text limits on
  system details count Unicode scalar values rather than UTF-16 code units.
- **`unavailable` order.** The server stores `unavailable` groups in the
  protocol's bit order. The v1 agent sent them in collection order, so a
  sample with several unavailable groups may list them in a different order
  than an equivalent v1 row. No v1 sample can be resent under v2, so this
  cannot create a conflict.
- **Measured on fixtures, not live hosts.** The byte results use
  fixture-derived and synthetic batches; a live capture from each host
  platform would confirm the representative sizes.
